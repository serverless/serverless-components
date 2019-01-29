const path = require('path')
const argv = require('minimist')(process.argv.slice(2))
const { fileExists } = require('@serverless/utils')
const getCli = require('./getCli')
const components = require('../../components')

// it's helpful to completely silent the cli
// during development and debugging
if (argv.silent) {
  process.env.SERVERLESS_SILENT = 'true'
  delete argv.silent // so that it's not passed to components
}

/*
 * "serverless" -> run default function in cwd
 * "serverless connect socket" -> run connect function in socket component, even if there's serverless.js in cwd
 * "serverless connect" -> run connect function in cwd
 * "serverless socket" -> if cwd has serverless.js, run "socket" function,
 *                        if not and "socket" component exists, run the default function in socket component
 */
const run = async () => {
  console.log('') // eslint-disable-line
  if (argv['_'].length < 2) {
    // eg. "serverless connect" or "serverless socket"
    const serverlessFilePath = path.join(process.cwd(), 'serverless.js')

    if (await fileExists(serverlessFilePath)) {
      // serverless.js exists in cwd
      const Component = require(serverlessFilePath)
      const component = new Component(undefined, getCli(true))

      if (argv['_'].length === 1) {
        // run the specified function from cwd Component. eg. "serverless connect"
        const command = argv['_'].shift()
        await component[command](argv || {})
      } else {
        // run the default function in cwd. eg. "serverless"
        await component(argv || {})
      }
    } else if (argv['_'].length === 1 && typeof components[argv['_'][0]] !== 'undefined') {
      // serverless.js does not exist in cwd & component exists in registry
      // eg. running "serverless socket" in directory that does not have serverless.js
      // in that case, run the default function in the socket component

      const component = new components[argv['_'][0]](undefined, getCli(true))
      await component(argv || {})
    } else {
      console.log('  no serverless.js found in cwd.') // eslint-disable-line
    }
  } else {
    // run specific function from specific component
    const command = argv['_'].shift()
    const componentName = argv['_'][0]

    if (typeof components[componentName] !== 'undefined') {
      // component exists in registry
      const component = new components[componentName](undefined, getCli(true))
      await component[command](argv || {})
    } else {
      console.log(`  Component ${componentName} does not exist`) // eslint-disable-line
    }
  }
  console.log('') // eslint-disable-line
}

module.exports = run