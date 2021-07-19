'use strict';

/*
 * Serverless Components: CLI Handler
 */

const path = require('path');
const http = require('http');
const https = require('https');
const minimist = require('minimist');
const dotenv = require('dotenv');
const semver = require('semver');
const chalk = require('chalk');
const HttpsProxyAgent = require('https-proxy-agent');
const CLI = require('./CLI');
const {
  loadTencentGlobalConfig,
  loadInstanceConfig,
  fileExistsSync,
  isProjectPath,
  isChinaUser,
} = require('./utils');

module.exports = async () => {
  const args = minimist(process.argv.slice(2));
  const instanceConfig = loadInstanceConfig(process.cwd());
  const stage = args.stage || (instanceConfig && instanceConfig.stage) || 'dev';

  const params = [];
  if (args._[1]) {
    params.push(args._[1]);
  }
  if (args._[2]) {
    params.push(args._[2]);
  }
  if (args._[3]) {
    params.push(args._[3]);
  }
  if (args._[4]) {
    params.push(args._[4]);
  }

  const config = { ...args, params };
  if (config._) {
    delete config._;
  }

  config.platformStage = process.env.SERVERLESS_PLATFORM_STAGE || 'prod';
  config.debug = process.env.SLS_DEBUG || !!args.debug;
  config.ci = !!args.ci

  // Add stage environment variable
  if (args.stage && !process.env.SERVERLESS_STAGE) {
    process.env.SERVERLESS_STAGE = args.stage;
  }

  // Initialize CLI utilities
  const cli = new CLI(config);

  /**
   * Load environment variables from .env files, 2 directories up
   * Nearest to current working directory is preferred
   */
  const defaultEnvFilePath = path.join(process.cwd(), '.env');
  const stageEnvFilePath = path.join(process.cwd(), `.env.${stage}`);
  const firstParentDefaultEnvFilePath = path.join(process.cwd(), '..', '.env');
  const firstParentStageEnvFilePath = path.join(process.cwd(), '..', `.env.${stage}`);
  const secondParentDefaultEnvFilePath = path.join(process.cwd(), '../..', '.env');
  const secondParentStageEnvFilePath = path.join(process.cwd(), '../..', `.env.${stage}`);

  let dotEnvContent;
  if (stage && fileExistsSync(stageEnvFilePath)) {
    dotEnvContent = dotenv.config({ path: path.resolve(stageEnvFilePath) });
  } else if (fileExistsSync(defaultEnvFilePath)) {
    dotEnvContent = dotenv.config({ path: path.resolve(defaultEnvFilePath) });
  } else if (fileExistsSync(firstParentStageEnvFilePath)) {
    dotEnvContent = dotenv.config({ path: path.resolve(firstParentStageEnvFilePath) });
  } else if (fileExistsSync(firstParentDefaultEnvFilePath)) {
    dotEnvContent = dotenv.config({ path: path.resolve(firstParentDefaultEnvFilePath) });
  } else if (fileExistsSync(secondParentStageEnvFilePath)) {
    dotEnvContent = dotenv.config({ path: path.resolve(secondParentStageEnvFilePath) });
  } else if (fileExistsSync(secondParentDefaultEnvFilePath)) {
    dotEnvContent = dotenv.config({ path: path.resolve(secondParentDefaultEnvFilePath) });
  }

  // temporary check to help users transition to providers
  config.usingLocalCredentials =
    dotEnvContent &&
    dotEnvContent.parsed &&
    dotEnvContent.parsed.AWS_ACCESS_KEY_ID &&
    dotEnvContent.parsed.AWS_SECRET_ACCESS_KEY;

  if (isChinaUser()) {
    loadTencentGlobalConfig(cli, config);
  }

  /**
   * Set global proxy agent if it's configured in environment variable
   */
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (httpProxy || httpsProxy) {
    if (semver.gte(process.version, 'v11.7.0')) {
      // save default global agent in case we want to restore them
      // and hand proxy handling to other libs
      http.defaultGlobalAgent = http.globalAgent;
      https.defaultGlobalAgent = https.globalAgent;
      http.globalAgent = new HttpsProxyAgent(httpProxy || httpsProxy);
      https.globalAgent = new HttpsProxyAgent(httpsProxy || httpProxy);
    } else {
      process.stdout.write(
        `Serverless: ${chalk.yellow(
          'you need to upgrade the NodeJS in order to use http/https proxy.(Nodejs >= 11.7)'
        )}\n`
      );
    }
  }

  // Check env file whether or not containing an inline comment, which is invalid for the dotenv package's parsing: https://github.com/motdotla/dotenv/issues/484
  if (dotEnvContent && dotEnvContent.parsed) {
    const envKeys = Object.keys(dotEnvContent.parsed);
    envKeys.forEach((key) => {
      const regexForComment = / #+.*$/g;
      const envValue = dotEnvContent.parsed[key];
      if (regexForComment.test(envValue)) {
        if (isChinaUser()) {
          cli.log(
            chalk.yellow(
              `在dotenv配置中字段${key}发现 #,请确保注释都写在单独由#开头的新一行, 不支持行内注释。详情查看：https://github.com/motdotla/dotenv#rules\n`
            )
          );
        } else {
          cli.log(
            chalk.yellow(
              `Found field ${key} in dotenv file has # symbol, please ensure all comments begin with a # symbol on a new line，no support for inline comment. Detail: https://github.com/motdotla/dotenv#rules\n`
            )
          );
        }
      }
    });
  }

  /**
   * Handle interactive onboarding when using the "serverless" command for China-based users
   */
  if (process.argv.length === 2 && isChinaUser() && !(await isProjectPath(process.cwd()))) {
    // Interactive onboarding
    return require('./interactive-onboarding/cn')(config, cli);
  }

  let commands;
  let InvalidCommandMsg =
    'Please enter a valid command. Run "serverless help" to see all available commands.';
  if (isChinaUser()) {
    commands = require('./commands-cn');
    InvalidCommandMsg =
      "检测到当前目录下已有 serverless 项目，请通过 'sls deploy' 进行部署，或在新路径下完成 serverless 项目初始化";
  } else {
    commands = require('./commands');
  }

  let command = args._[0];

  // handle "publish" command.
  if (command === 'publish') {
    command = 'registry';
    config.params.unshift('publish');
  }

  // // handle "unpublish" command.
  if (command === 'unpublish') {
    command = 'registry';
    config.params.unshift('unpublish');
  }
  /**
   * Running "serverless --help" is equivalent to "serverless help"
   */
  if (args.help || args.h || args['help-components']) {
    config.originalCommand = command;
    command = 'help';
  }

  // Handle version command. Log and exit.
  // TODO: Move this to a command file like all others. Don't handle this here.
  const checkingVersion = args._[0] === 'version' || args.version || args.v;
  if (checkingVersion) {
    return cli.logVersion();
  }

  try {
    if (!command) {
      throw new Error(InvalidCommandMsg);
    }

    if (commands[command]) {
      await commands[command](config, cli, command);
    } else {
      await commands.run(config, cli, command);
    }
  } catch (error) {
    process.exitCode = 1;
    if (error.isWarning) {
      cli.logWarning(error);
    } else if (cli.isSessionActive()) {
      cli.sessionStop('error', error);
    } else {
      cli.logError(error);
      cli.log();
    }
  }

  return null;
};
