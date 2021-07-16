'use strict';

/*
 * Serverless Components: Utilities
 */

const os = require('os');
const { mergeRight, endsWith, isEmpty } = require('ramda');
const memoize = require('memoizee');
const path = require('path');
const fse = require('fs-extra');
const YAML = require('js-yaml');
const chalk = require('chalk');
const traverse = require('traverse');
const { Graph, alg } = require('graphlib');

/**
 * Checks if a file exists
 * @param {*} filePath
 */
const fileExistsSync = (filePath) => {
  try {
    const stats = fse.lstatSync(filePath);
    return stats.isFile() || stats.isSymbolicLink();
  } catch (e) {
    return false;
  }
};

/**
 * Checks if a file exists
 * @param {*} filePath
 */
const fileExists = async (filePath) => {
  try {
    const stats = await fse.lstat(filePath);
    return stats.isFile() || stats.isSymbolicLink();
  } catch (error) {
    return false;
  }
};

/**
 * Determines if a given file path is a YAML file
 * @param {*} filePath
 */
const isYamlPath = (filePath) => endsWith('.yml', filePath) || endsWith('.yaml', filePath);

/**
 * Determines if a given file path is a JSON file
 * @param {*} filePath
 */
const isJsonPath = (filePath) => endsWith('.json', filePath);

/**
 * Reads a file on the file system
 * @param {*} filePath
 * @param {*} options
 */
const readAndParseSync = (filePath, options = {}) => {
  if (!fileExistsSync(filePath)) {
    throw new Error(`File does not exist at this path ${filePath}`);
  }

  const contents = fse.readFileSync(filePath, 'utf8');
  if (isJsonPath(filePath)) {
    return JSON.parse(contents);
  } else if (isYamlPath(filePath)) {
    return YAML.load(contents.toString(), mergeRight(options, { filename: filePath }));
  } else if (filePath.endsWith('.slsignore')) {
    return contents.toString().split('\n');
  }
  return contents.toString().trim();
};

const validateAgainstV1Variables = (variable) => {
  const v1Variables = ['self', 'opt', 'sls', 'cf', 's3', 'ssm', 'file'];

  for (const v1Variable of v1Variables) {
    const v1VariableRegex = new RegExp(`\\\${${v1Variable}:([\\w.-_]+)}`, 'g');
    if (v1VariableRegex.test(variable)) {
      throw new Error(
        `Serverless Framework Components do not support this Variable: "${variable}".  Here are the Variables supported by Components: https://git.io/JJshw`
      );
    }
  }
};

/**
 * Resolves any variables that require resolving before the engine.
 * This currently supports only ${env}.  All others should be resolved within the deployment engine.
 * @param {*} inputs
 */
const resolveVariables = (inputs) => {
  const regex = /\${(\w*:?[\w\d.-]+)}/g;
  let variableResolved = false;
  const resolvedInputs = traverse(inputs).forEach(function (value) {
    const matches = typeof value === 'string' ? value.match(regex) : null;
    if (matches) {
      let newValue = value;
      for (const match of matches) {
        // make sure users are not using v1 variables
        validateAgainstV1Variables(match);
        // Search for ${env:}
        if (/\${env:(\w*[\w.-_]+)}/g.test(match)) {
          const referencedPropertyPath = match.substring(2, match.length - 1).split(':');
          newValue = process.env[referencedPropertyPath[1]];
          variableResolved = true;
          if (match === value) {
            newValue = process.env[referencedPropertyPath[1]];
          } else {
            newValue = value.replace(match, process.env[referencedPropertyPath[1]]);
          }
        }
      }
      this.update(newValue);
    }
  });
  if (variableResolved) {
    return resolveVariables(resolvedInputs);
  }
  return resolvedInputs;
};

/**
 * check if any file exists with the fileName and format, if yes, return the filepath
 * @param {*} directoryPath
 * @param {*} fileName
 * @param{*} formats
 */
const getFilePath = (directoryPath, fileName, formats) => {
  directoryPath = path.resolve(directoryPath);
  let filePath;

  formats.each((format) => {
    const filePathWithFormat = path.join(directoryPath, `${fileName}.${format}`);
    if (fileExistsSync(filePathWithFormat)) {
      filePath = filePathWithFormat;
    }
  });

  return filePath;
};

/**
 * Reads a serverless component config file in a given directory path
 * @param {*} directoryPath
 */
const loadComponentConfig = (directoryPath) => {
  let componentFile;
  const filePath = getFilePath(directoryPath, 'serverless.component', ['yml', 'yaml', 'json']);
  if (!filePath) return null;

  // Read file
  const isYaml = isYamlFile(filePath);
  if (isYaml) {
    try {
      componentFile = readAndParseSync(filePath);
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e;
      }
    }
  } else {
    componentFile = readAndParseSync(filePath);
  }

  return componentFile;
};

/**
 * Reads a serverless template config file in a given directory path
 * @param {*} directoryPath
 */
const loadTemplateConfig = (directoryPath) => {
  let templateFile;
  const filePath = getFilePath(directoryPath, 'serverless.template', ['yml', 'yaml', 'json']);

  if (!filePath) return null;

  // Read file
  const isYaml = isYamlFile(filePath);
  if (isYaml) {
    try {
      templateFile = readAndParseSync(filePath);
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e;
      }
    }
  } else {
    templateFile = readAndParseSync(filePath);
  }

  return templateFile;
};

/**
 *
 * Checks if a filename ends with yaml or yml
 * @param {*} filename
 */
const isYamlFile = (filename) => {
  return (filename && filename.endsWith('yaml')) || (filename && filename.endsWith('yml'));
};

/**
 * Returns the path of the serverless file found in the given directory
 * @param {*} filePath
 */
const getServerlessFilePath = (directoryPath) => {
  const filePath = getFilePath(directoryPath, 'serverless', ['yml', 'yaml', 'json', 'js']);

  if (!filePath) {
    return null;
  }
  return filePath;
};

/**
 * Reads and parses a the serverless config file found in the parent directory
 * @param {*} directoryPath
 */
const loadParentConfigFile = (directoryPath) => {
  const parentConfigFilePath = path.resolve(directoryPath, '..');
  let configFile;
  const filePath = getServerlessFilePath(parentConfigFilePath);

  // If no filePath, the serverless config file does not exist
  if (!filePath) {
    return null;
  }

  // Read file, if it's yaml/yml
  if (isYamlFile(filePath)) {
    try {
      configFile = readAndParseSync(filePath);
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e;
      }
    }
  } else {
    configFile = readAndParseSync(filePath);
  }

  return configFile;
};

/**
 * Reads a serverless instance config file in a given directory path
 * @param {*} directoryPath
 */
const loadInstanceConfigUncached = (directoryPath) => {
  let instanceFile;
  const filePath = getFilePath(directoryPath, 'serverless', ['yml', 'yaml', 'json']);

  if (!filePath) {
    return null;
  }

  // Read file
  const isYaml = isYamlFile(filePath);
  if (isYaml) {
    try {
      instanceFile = readAndParseSync(filePath);
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e;
      } else {
        throw new Error(`The serverless.yml file has incorrect format. Details: ${e.message}`);
      }
    }
  } else {
    instanceFile = readAndParseSync(filePath);
  }

  // Set default stage
  if (!instanceFile.stage) {
    instanceFile.stage = 'dev';
  }

  // inherit properties from parent if they exist
  const parentConfigFile = loadParentConfigFile(directoryPath);
  if (parentConfigFile) {
    instanceFile.app = parentConfigFile.app || instanceFile.app;
    instanceFile.stage = parentConfigFile.stage || instanceFile.stage;
    instanceFile.org = parentConfigFile.org || instanceFile.org;
  }

  // If no app, set it from the "name" property
  if (!instanceFile.app) {
    instanceFile.app = instanceFile.name;
  }

  return instanceFile;
};

/**
 * Reads a serverless instance config file in a given directory path
 * and caches for subsequent calls
 * @param {*} directoryPath
 */
const loadInstanceConfig = memoize(loadInstanceConfigUncached);

/**
 * THIS IS USED BY SFV1.  DO NOT MODIFY OR DELETE
 */
const legacyLoadInstanceConfig = (directoryPath) => {
  directoryPath = path.resolve(directoryPath);
  const ymlFilePath = path.join(directoryPath, 'serverless.yml');
  const yamlFilePath = path.join(directoryPath, 'serverless.yaml');
  const jsonFilePath = path.join(directoryPath, 'serverless.json');
  let filePath;
  let isYaml = false;
  let instanceFile;

  // Check to see if exists and is yaml or json file
  if (fileExistsSync(ymlFilePath)) {
    filePath = ymlFilePath;
    isYaml = true;
  }
  if (fileExistsSync(yamlFilePath)) {
    filePath = yamlFilePath;
    isYaml = true;
  }
  if (fileExistsSync(jsonFilePath)) {
    filePath = jsonFilePath;
  }

  if (!filePath) {
    throw new Error(`The following file could not be found: ${filePath}`);
  }

  // Read file
  if (isYaml) {
    try {
      instanceFile = readAndParseSync(filePath);
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e;
      }
    }
  } else {
    instanceFile = readAndParseSync(filePath);
  }

  return instanceFile;
};

/**
 * THIS IS USED BY SFV1.  DO NOT MODIFY OR DELETE
 */
const legacyLoadComponentConfig = (directoryPath) => {
  let componentFile;
  const filePath = getFilePath(directoryPath, 'serverless.component', ['yml', 'yaml', 'json']);

  if (!filePath) {
    throw new Error(
      'The serverless.component file could not be found in the current working directory.'
    );
  }

  // Read file
  const isYaml = isYamlFile(filePath);
  if (isYaml) {
    try {
      componentFile = readAndParseSync(filePath);
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e;
      }
    }
  } else {
    componentFile = readAndParseSync(filePath);
  }

  return componentFile;
};

const possibleConfigurationFiles = [
  'serverless.yml',
  'serverless.yaml',
  'serverless.json',
  'serverless.js',
  'serverless.component.yml',
  'serverless.component.yaml',
  'serverless.component.json',
];

const isProjectPath = async (inputPath) => {
  for (const configurationFile of possibleConfigurationFiles) {
    if (await fse.pathExists(path.join(inputPath, configurationFile))) {
      return true;
    }
  }
  return false;
};

const isDeployableProjectExists = (inputPath) => {
  for (const configurationFile of possibleConfigurationFiles) {
    const configurationFilePath = path.join(inputPath, configurationFile);
    if (fileExistsSync(configurationFilePath)) {
      const content = readAndParseSync(configurationFilePath);
      if (content.component || content.service) {
        // if component instance or framework project
        return true;
      }
      // anything
      return false;
    }
  }
  return false;
};

const checkTemplateAppAndStage = (root) => {
  try {
    if (isDeployableProjectExists(root)) {
      // if cwd contains a serverless.yml file that can be deployed we return immediately
      // to let users deploy their projects in cwd (v1 or component instance)
      return false;
    }
    const itemNames = fse.readdirSync(root);

    const apps = new Set();
    let hasNullApp = false;
    const stages = new Set();
    let hasNullStage = false;

    for (const itemName of itemNames) {
      const itemPath = path.join(root, itemName);
      if (!itemName.startsWith('.') && fse.statSync(itemPath).isDirectory()) {
        const instanceYml = loadInstanceConfig(itemPath);
        if (instanceYml) {
          if (instanceYml.stage) {
            stages.add(instanceYml.stage);
          } else {
            hasNullStage = true;
          }
          if (instanceYml.app) {
            apps.add(instanceYml.app);
          } else {
            hasNullApp = true;
          }
        }
      }
    }

    // If we need to check the app and stage value for all sub folders, if we have more than 1 app value or at least one folder's yml has app but others do not have, we think it's not a valid template project
    // same to stage value. Valid template standard: 1. All sub folders do not have app and stage; 2. All sub folders have one same app and stage.
    return !(
      apps.size > 1 ||
      (apps.size === 1 && hasNullApp) ||
      stages.size > 1 ||
      (stages.size === 1 && hasNullStage)
    );
  } catch (error) {
    return false;
  }
};

const runningTemplate = (root) => {
  try {
    if (isDeployableProjectExists(root)) {
      // if cwd contains a serverless.yml file that can be deployed we return immediately
      // to let users deploy their projects in cwd (v1 or component instance)
      return false;
    }
    const itemNames = fse.readdirSync(root);

    let hasComponentProject = false;

    for (const itemName of itemNames) {
      const itemPath = path.join(root, itemName);
      if (!itemName.startsWith('.') && fse.statSync(itemPath).isDirectory()) {
        const instanceYml = loadInstanceConfig(itemPath);
        if (instanceYml) {
          if (instanceYml.component) {
            hasComponentProject = true;
          } else {
            // has other version(e.g. v1) of serverless.yml
            return false;
          }
        }
      }
    }

    return hasComponentProject;
  } catch (error) {
    return false;
  }
};

const getOutputs = (allComponentsWithOutputs) => {
  const outputs = {};

  for (const [instanceName, component] of Object.entries(allComponentsWithOutputs)) {
    outputs[instanceName] = component.outputs;
  }

  return outputs;
};

const validateGraph = (graph) => {
  const isAcyclic = alg.isAcyclic(graph);
  if (!isAcyclic) {
    const cycles = alg.findCycles(graph);
    let msg = ['Your template has circular dependencies:'];
    cycles.forEach((cycle, index) => {
      let fromAToB = cycle.join(' --> ');
      fromAToB = `${(index += 1)}. ${fromAToB}`;
      const fromBToA = cycle.reverse().join(' <-- ');
      const padLength = fromAToB.length + 4;
      msg.push(fromAToB.padStart(padLength));
      msg.push(fromBToA.padStart(padLength));
    }, cycles);
    msg = msg.join('\n');
    throw new Error(msg);
  }
};

const getAllComponents = (template = {}) => {
  const { org, app, stage } = template;
  // todo specify org, app, stage...etc
  const allComponents = {};

  for (const [key, value] of Object.entries(template)) {
    if (value && value.component) {
      allComponents[key] = {
        name: key,
        component: value.component,
        org,
        app,
        stage,
        inputs: value.inputs || {},
      };
    }
  }

  return allComponents;
};

const setDependencies = (allComponents) => {
  const regex = /\${output:(\w*[-_${}:\w.]+)}/g;

  for (const component of Object.values(allComponents)) {
    const dependencies = traverse(component.inputs).reduce((accum, value) => {
      const matches = typeof value === 'string' ? value.match(regex) : null;
      if (matches) {
        for (const match of matches) {
          const splittedVariableString = match.substring(2, match.length - 1).split(':');
          const referencedInstanceString =
            splittedVariableString[splittedVariableString.length - 1];

          const referencedInstanceName = referencedInstanceString.split('.')[0];

          if (allComponents[referencedInstanceName] && !accum.includes(referencedInstanceName)) {
            accum.push(referencedInstanceName);
          }
        }
      }
      return accum;
    }, []);

    component.dependencies = dependencies;
  }

  return allComponents;
};

const createGraph = (allComponents, command) => {
  const graph = new Graph();

  for (const [instanceName, component] of Object.entries(allComponents)) {
    graph.setNode(instanceName, component);
  }

  for (const [instanceName, component] of Object.entries(allComponents)) {
    const { dependencies } = component;
    if (!isEmpty(dependencies)) {
      for (const dependency of dependencies) {
        if (command === 'remove') {
          graph.setEdge(dependency, instanceName);
        } else {
          graph.setEdge(instanceName, dependency);
        }
      }
    }
  }

  validateGraph(graph);

  return graph;
};

const executeGraph = async (allComponents, command, graph, cli, sdk, options) => {
  const leaves = graph.sinks();

  if (isEmpty(leaves)) {
    return allComponents;
  }

  const promises = [];
  const componentCount = Object.keys(allComponents).length;
  const successCount = options.successCount || 0;
  if (command === 'remove') {
    cli.sessionStatus(`[${successCount + 1}/${componentCount}] 正在删除 ${leaves.join(', ')}`);
  } else {
    cli.sessionStatus(`[${successCount + 1}/${componentCount}] 正在部署 ${leaves.join(', ')}`);
  }

  for (const instanceName of leaves) {
    const fn = async () => {
      const instanceYaml = allComponents[instanceName];

      if (command === 'remove') {
        let instance;

        // do not pass inputs to remove command
        instanceYaml.inputs = {};

        try {
          instance = await sdk.remove(instanceYaml, options);
        } catch (error) {
          // Add helpful information
          if (!isChinaUser()) {
            if (error.name === 'Invalid Component Types') {
              error.message = `Invalid Input: ${error.message}`;
            }
            if (error.details && error.details.repo) {
              error.message = `${error.message} - Documentation: ${error.details.repo}`;
            }
            error.documentation = false;
            error.support = false;
            error.chat = false;
          }

          // Prefix with app name
          error.message = `${instanceYaml.name}: ${error.message}`;

          cli.logError(error, { hideEntity: true });

          allComponents[instanceName].error = error;
          return null;
        }
        allComponents[instanceName].outputs = instance.outputs || {};
      } else {
        let instance;
        try {
          instance = await sdk.deploy(instanceYaml, options);
        } catch (error) {
          // Add helpful information
          if (!isChinaUser()) {
            if (error.name === 'Invalid Component Types') {
              error.message = `Invalid Input: ${error.message}`;
            }
            if (error.details && error.details.repo) {
              error.message = `${error.message} - Documentation: ${error.details.repo}`;
            }
            error.documentation = false;
            error.support = false;
            error.chat = false;
          }

          // Prefix with app name
          error.message = `${instanceYaml.name}: ${error.message}`;

          cli.logError(error, { hideEntity: true });
          allComponents[instanceName].error = error;
          return null;
        }

        const outputs = {};
        outputs[instanceName] = instance.outputs;

        if (!options.debug) {
          cli.log();
          cli.log(chalk.bold(`${instanceName} 部署成功:`));
          cli.log('---------------------------------------------');
          cli.logOutputs(instance.outputs);
        }

        allComponents[instanceName].outputs = instance.outputs || {};
      }
      return null;
    };

    promises.push(fn());
  }

  await Promise.all(promises);

  for (const instanceName of leaves) {
    graph.removeNode(instanceName);
  }

  options.successCount = successCount + leaves.length;

  return executeGraph(allComponents, command, graph, cli, sdk, options);
};

/**
 * Detect if the user is located in China by looking at their settings
 */
const isChinaUser = () => {
  let result;
  if (
    process.env.SERVERLESS_PLATFORM_VENDOR === 'tencent' ||
    process.env.SLS_GEO_LOCATION === 'cn'
  ) {
    result = true;
  } else if (process.env.SERVERLESS_PLATFORM_VENDOR === 'aws') {
    result = false;
  } else {
    result = new Intl.DateTimeFormat('en', { timeZoneName: 'long' })
      .format()
      .includes('China Standard Time');
  }

  return result;
};

/**
 * Makes sure user ran "npm install" if package.json with dependencies was found
 */
const validateNodeModules = async (directory) => {
  const srcPath = path.resolve(process.cwd(), directory);
  const packageJsonPath = path.resolve(srcPath, 'package.json');

  // only validate node modules if package.json exists
  if (await fileExists(packageJsonPath)) {
    const packageJson = readAndParseSync(packageJsonPath);

    const hasDependencies = Object.keys(packageJson.dependencies).length > 0;

    // only validate node modules if there are dependencies in package.json
    if (hasDependencies) {
      const nodeModulesExists = await fse.pathExists(path.resolve(srcPath, 'node_modules'));

      if (!nodeModulesExists) {
        throw new Error(
          'node_modules was not found in the current working directory, or the "src" directory you specified. Did you run "npm install"?'
        );
      }
    }
  }
};

const isJson = (str) => {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
};

/**
 * Parses CLI inputs in the following syntax:
 *   serverless invoke --inputs key=value foo=bar
 *
 * It automatically converts to string, boolean, number, array and object types.
 *
 * In case of array, the syntax looks like this:
 *   serverless invoke --inputs names=abc,xyz
 *
 * In case of object, we use JSON syntax that looks like this:
 *   serverless invoke --inputs env='{"LANG": "en"}'
 *
 * @returns Object
 */
const parseCliInputs = () => {
  const rawArgs = process.argv.slice(2);

  // to avoid any possible conflicts, only do this if --inputs is passed in
  if (!rawArgs.includes('--inputs')) {
    return {};
  }

  const rawInputs = rawArgs.filter((rawArg) => rawArg.includes('='));

  // set the type of the cli input (ie. convert the string "true" to true)
  // supports strings, numbers, booleans & arrays
  const setCliInputValueType = (value) => {
    // check if string is actually a json object and just parse it
    if (isJson(value)) {
      return JSON.parse(value);
    }

    // check if the string is actually an array
    if (value.includes(',')) {
      value = value.split(',');
      return value.map((v) => setCliInputValueType(v));
    }

    // check if the string is actually a number
    if (!isNaN(value)) {
      value = Number(value);
    }

    // check if the string is actually boolean
    value = value === 'true' || (value === 'false' ? false : value);

    // return the final value
    return value;
  };

  // convert the raw inputs array to the familiar inputs object
  const cliInputs = rawInputs.reduce((accum, rawInput) => {
    const key = rawInput.split('=')[0];
    const value = rawInput.split('=')[1];

    accum[key] = setCliInputValueType(value);

    return accum;
  }, {});

  // return the parsed cli inputs as an object
  return cliInputs;
};

const hasServerlessConfigFile = (inputPath) => {
  const possibleConfigFiles = [
    'serverless.yml',
    'serverless.yaml',
    'serverless.json',
    'serverless.js',
    'serverless.ts',
  ];

  for (const possibleConfigFile of possibleConfigFiles) {
    if (fileExistsSync(path.join(inputPath, possibleConfigFile))) {
      return true;
    }
  }
  return false;
};

const getInstanceConfigPath = (inputPath) => {
  const possibleConfigFiles = [
    'serverless.yml',
    'serverless.yaml',
    'serverless.json',
    'serverless.js',
    'serverless.ts',
  ];

  for (const possibleConfigFile of possibleConfigFiles) {
    const possibleConfigFilePath = path.join(inputPath, possibleConfigFile);
    if (fileExistsSync(possibleConfigFilePath)) {
      return possibleConfigFilePath;
    }
  }
  return null;
};

// temporary UX function to help users transition to providers
const checkLocalCredentials = async (sdk, config, orgName) => {
  const org = await sdk.getOrgByName(orgName);

  const { result: providers } = await sdk.getProviders(org.orgUid);

  const defaultProvider = providers.find((p) => p.isDefault);

  if (!defaultProvider && config.usingLocalCredentials) {
    let dashboardStage = 'serverless';

    if (process.env.SERVERLESS_PLATFORM_STAGE === 'dev') {
      dashboardStage = 'serverless-dev';
    }
    throw new Error(
      `Using local credentials is no longer supported. Please link a provider to a service or set a default provider on the dashboard by visiting this URL: \n\n  https://app.${dashboardStage}.com/${orgName}/settings/providers?providerId=new&provider=aws`
    );
  }
};

const loadTencentGlobalConfig = (cli, config = {}) => {
  // Users do not want to use global credentials
  if (config.login) {
    return;
  }

  const profile = process.env.TENCENT_CREDENTIALS_PROFILE || config.profile || 'default';

  const globalTencentCredentials = path.join(os.homedir(), '.serverless/tencent/credentials');
  if (fileExistsSync(globalTencentCredentials)) {
    const credContent = loadCredentialsToJson(globalTencentCredentials);
    const envToInsert = credContent[profile];
    if (!envToInsert) {
      // If the user indicates the profile to be used, but the profile doesn't exist, throw a warning and stop the process, or only skip the global credentials and continue normal process
      if (config.profile || process.env.TENCENT_CREDENTIALS_PROFILE) {
        cli.log(
          `Serverless: ${chalk.yellow(
            `授权信息 ${profile} 不存在，请通过 serverless credentials list 查看当前授权信息`
          )}`
        );
        process.exit();
      }

      return;
    }

    if (cli && cli.log) {
      // only show tip messgae for commands need login credentials info
      if (!process.env.TENCENT_SECRET_KEY && !process.env.TENCENT_SECRET_ID) {
        config.useTencentCredential = profile;
      }
    }

    for (const [key, value] of Object.entries(envToInsert)) {
      // it will not override exsting env variables
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
};

const loadCredentialsToJson = (credPath) => {
  if (!fileExistsSync(credPath)) {
    throw new Error(`Can not find credentials in ${credPath}`);
  }
  let credContent = fse.readFileSync(credPath, { encoding: 'utf-8' });
  credContent = credContent
    .trim()
    .split('\n')
    .filter((v) => !!v);
  const res = {};
  let key = '';
  credContent.forEach((item) => {
    if (item.includes('[')) {
      key = item.slice(1, -1);
      if (!res[key]) {
        res[key] = {};
      }
    } else {
      const [kkey, vvalue] = item.split('=');
      res[key][kkey] = vvalue;
    }
  });
  return res;
};

const writeJsonToCredentials = (credPath, content = {}) => {
  if (!credPath) {
    throw new Error('Missing required credentials path field');
  }
  let writeContent = '';
  for (const [key, value] of Object.entries(content)) {
    writeContent += `[${key}]\n`;

    for (const [kkey, vvalue] of Object.entries(value)) {
      writeContent += `${kkey}=${vvalue}\n`;
    }
    writeContent += '\n';
  }
  fse.writeFileSync(credPath, writeContent);
};
module.exports = {
  fileExists,
  fileExistsSync,
  readAndParseSync,
  isYamlPath,
  isJson,
  isJsonPath,
  resolveVariables,
  loadComponentConfig,
  loadTemplateConfig,
  loadInstanceConfig,
  loadInstanceConfigUncached,
  legacyLoadComponentConfig,
  legacyLoadInstanceConfig,
  isProjectPath,
  runningTemplate,
  getOutputs,
  getAllComponents,
  setDependencies,
  validateGraph,
  createGraph,
  executeGraph,
  isChinaUser,
  validateNodeModules,
  parseCliInputs,
  hasServerlessConfigFile,
  getInstanceConfigPath,
  checkLocalCredentials,
  checkTemplateAppAndStage,
  loadTencentGlobalConfig,
  loadCredentialsToJson,
  writeJsonToCredentials,
};
