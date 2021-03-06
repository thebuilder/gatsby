const chokidar = require(`chokidar`)
const fs = require(`fs`)
const path = require(`path`)
const { Machine } = require(`xstate`)

const { createFileNode } = require(`./create-file-node`)

/**
 * Create a state machine to manage Chokidar's not-ready/ready states.
 */
const createFSMachine = () =>
  Machine({
    key: `emitFSEvents`,
    parallel: true,
    strict: true,
    states: {
      CHOKIDAR: {
        initial: `CHOKIDAR_NOT_READY`,
        states: {
          CHOKIDAR_NOT_READY: {
            on: {
              CHOKIDAR_READY: `CHOKIDAR_WATCHING`,
              BOOTSTRAP_FINISHED: `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`,
            },
          },
          CHOKIDAR_WATCHING: {
            on: {
              BOOTSTRAP_FINISHED: `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`,
              CHOKIDAR_READY: `CHOKIDAR_WATCHING`,
            },
          },
          CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED: {
            on: {
              CHOKIDAR_READY: `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`,
            },
          },
        },
      },
    },
  })

exports.sourceNodes = (
  { actions, getNode, createNodeId, hasNodeChanged, reporter, emitter },
  pluginOptions
) => {
  const { createNode, deleteNode } = actions

  // Validate that the path exists.
  if (!fs.existsSync(pluginOptions.path)) {
    reporter.panic(`
The path passed to gatsby-source-filesystem does not exist on your file system:

${pluginOptions.path}

Please pick a path to an existing directory.

See docs here - https://www.gatsbyjs.org/packages/gatsby-source-filesystem/
      `)
  }

  // Validate that the path is absolute.
  // Absolute paths are required to resolve images correctly.
  if (!path.isAbsolute(pluginOptions.path)) {
    pluginOptions.path = path.resolve(process.cwd(), pluginOptions.path)
  }

  const fsMachine = createFSMachine()
  let currentState = fsMachine.initialState

  // Once bootstrap is finished, we only let one File node update go through
  // the system at a time.
  emitter.on(`BOOTSTRAP_FINISHED`, () => {
    currentState = fsMachine.transition(
      currentState.value,
      `BOOTSTRAP_FINISHED`
    )
  })

  const watcher = chokidar.watch(pluginOptions.path, {
    ignored: [
      `**/*.un~`,
      `**/.DS_Store`,
      `**/.gitignore`,
      `**/.npmignore`,
      `**/.babelrc`,
      `**/yarn.lock`,
      `**/bower_components`,
      `**/node_modules`,
      `../**/dist/**`,
      ...(pluginOptions.ignore || []),
    ],
  })

  const createAndProcessNode = path => {
    const fileNodePromise = createFileNode(
      path,
      createNodeId,
      pluginOptions
    ).then(fileNode => {
      createNode(fileNode)
      return null
    })
    return fileNodePromise
  }

  // For every path that is reported before the 'ready' event, we throw them
  // into a queue and then flush the queue when 'ready' event arrives.
  // After 'ready', we handle the 'add' event without putting it into a queue.
  let pathQueue = []
  const flushPathQueue = () => {
    let queue = pathQueue.slice()
    pathQueue = []
    return Promise.all(queue.map(createAndProcessNode))
  }

  watcher.on(`add`, path => {
    if (currentState.value.CHOKIDAR !== `CHOKIDAR_NOT_READY`) {
      if (
        currentState.value.CHOKIDAR === `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`
      ) {
        reporter.info(`added file at ${path}`)
      }
      createAndProcessNode(path).catch(err => reporter.error(err))
    } else {
      pathQueue.push(path)
    }
  })

  watcher.on(`change`, path => {
    if (
      currentState.value.CHOKIDAR === `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`
    ) {
      reporter.info(`changed file at ${path}`)
    }
    createAndProcessNode(path).catch(err => reporter.error(err))
  })

  watcher.on(`unlink`, path => {
    if (
      currentState.value.CHOKIDAR === `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`
    ) {
      reporter.info(`file deleted at ${path}`)
    }
    const node = getNode(createNodeId(path))
    // It's possible the file node was never created as sometimes tools will
    // write and then immediately delete temporary files to the file system.
    if (node) {
      deleteNode({ node })
    }
  })

  watcher.on(`addDir`, path => {
    if (currentState.value.CHOKIDAR !== `CHOKIDAR_NOT_READY`) {
      if (
        currentState.value.CHOKIDAR === `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`
      ) {
        reporter.info(`added directory at ${path}`)
      }
      createAndProcessNode(path).catch(err => reporter.error(err))
    } else {
      pathQueue.push(path)
    }
  })

  watcher.on(`unlinkDir`, path => {
    if (
      currentState.value.CHOKIDAR === `CHOKIDAR_WATCHING_BOOTSTRAP_FINISHED`
    ) {
      reporter.info(`directory deleted at ${path}`)
    }
    const node = getNode(createNodeId(path))
    if (node) {
      deleteNode({ node })
    }
  })

  return new Promise((resolve, reject) => {
    watcher.on(`ready`, () => {
      currentState = fsMachine.transition(currentState.value, `CHOKIDAR_READY`)
      flushPathQueue().then(resolve, reject)
    })
  })
}

exports.setFieldsOnGraphQLNodeType = require(`./extend-file-node`)

exports.createSchemaCustomization = ({ actions }) => {
  const { createTypes } = actions
  const typeDefs = `
  type File implements Node @infer {
    birthtime: Date @deprecated(reason: "Use \`birthTime\` instead")
    birthtimeMs: Float @deprecated(reason: "Use \`birthTime\` instead")
  }
  `
  createTypes(typeDefs)
}
