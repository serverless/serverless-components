'use strict';

/*
 * CLI: Command: Dev
 */

const path = require('path');
const { Writable } = require('stream');
const ansiEscapes = require('ansi-escapes');
const chokidar = require('chokidar');
const { ServerlessSDK, utils: chinaUtils } = require('@serverless/platform-client-china');
const { generatePayload, storeLocally } = require('./telemtry');
const { v4: uuidv4 } = require('uuid');
const utils = require('./utils');

class LogForwardingOutput extends Writable {
  _write(chunk, encoding, callback) {
    process.stdout.write(ansiEscapes.eraseDown);
    process.stdout._write(chunk, encoding, callback);
    process.stdout.write(ansiEscapes.cursorLeft);
  }

  _writev(chunks, callback) {
    process.stdout.write(ansiEscapes.eraseDown);
    process.stdout._writev(chunks, callback);
    process.stdout.write(ansiEscapes.cursorLeft);
  }
}

const logForwardingOutput = new LogForwardingOutput();
let functionInfoStore = null;
let regionStore = null;
let cliEventCallback = null;

const getInstanceInfo = async (sdk, instance) => {
  const { instance: instanceInfo } = await sdk.getInstance(
    instance.org,
    instance.stage,
    instance.app,
    instance.name
  );
  return instanceInfo;
};

/*
 * Deploy changes and hookup event callback which will be called when
 * deploying status has been changed.
 * @param sdk - instance of ServerlessSDK
 * @param instance - instance object
 * @param credentials - credentials used for deploy
 * @param enventCallback - event callback, when set to false, it will remove all event listener
 */
async function deploy(sdk, instance, credentials) {
  // The new debug api does not support deploying instance while it's in debugging mode, so stop it before deployment
  if (
    functionInfoStore &&
    regionStore &&
    cliEventCallback &&
    chinaUtils.doesRuntimeSupportDebug(functionInfoStore.runtime)
  ) {
    await chinaUtils.stopTencentRemoteLogAndDebug(functionInfoStore, regionStore, cliEventCallback);
  }
  let instanceInfo = {};

  try {
    await sdk.deploy(instance, credentials);
    const instanceStatusPollingStartTime = new Date().getTime();
    instanceInfo = await getInstanceInfo(sdk, instance);
    while (instanceInfo.instanceStatus === 'deploying') {
      instanceInfo = await getInstanceInfo(sdk, instance);
      if (Date.now() - instanceStatusPollingStartTime > 24000) {
        throw new Error('部署超时，请稍后重试');
      }
    }
  } catch (e) {
    instanceInfo.instanceStatus = 'error';
    instanceInfo.deploymentError = e;
  }

  return instanceInfo;
}

async function updateDeploymentStatus(cli, instanceInfo, startDebug) {
  const { instanceStatus, instanceName, deploymentError, deploymentErrorStack } = instanceInfo;
  const d = new Date();
  const header = `${d.toLocaleTimeString()} - ${instanceName} - deployment`;

  cliEventCallback.stdout = logForwardingOutput;

  switch (instanceStatus) {
    case 'active': {
      const {
        state: { lambdaArn, region },
        outputs: { scf, namespace },
      } = instanceInfo;
      let runtime = instanceInfo.outputs.runtime;
      regionStore = region;

      if (!runtime) {
        runtime = instanceInfo.inputs.runtime;
      }

      let runtimeInfo = runtime;
      let namespaceInfo = namespace;
      if (!runtimeInfo && scf) {
        runtimeInfo = scf.runtime;
      }
      if (!namespaceInfo && scf) {
        namespaceInfo = scf.namespace;
      }
      if (lambdaArn && runtimeInfo && region) {
        const functionInfo = {
          functionName: lambdaArn,
          namespace: namespaceInfo,
          runtime: runtimeInfo,
        };
        functionInfoStore = functionInfo;
        await chinaUtils.stopTencentRemoteLogAndDebug(functionInfo, region, cliEventCallback);
        if (startDebug) {
          await chinaUtils.startTencentRemoteLogAndDebug(functionInfo, region, cliEventCallback);
          setTimeout(() => {
            chinaUtils.startTencentRemoteLogAndDebug(functionInfo, region, cliEventCallback);
          }, 10000);
        }
      }
      cli.log(header, 'grey');
      delete instanceInfo.outputs.vendorMessage;
      cli.logOutputs(instanceInfo.outputs);
      cli.sessionStatus('监听中');
      return true;
    }
    case 'error':
      cli.log(`${header} error`, 'grey');
      cli.log(deploymentErrorStack || deploymentError, 'red');
      cli.sessionStatus('监听中');
      break;
    default:
      cli.log(`部署失败，当前实例状态不支持更改: ${instanceStatus}`, 'red');
  }
  return false;
}

// eslint-disable-next-line consistent-return
module.exports = async (config, cli, command) => {
  // Load serverless component instance.  Submit a directory where its config files should be.
  let instanceDir = process.cwd();
  if (config.target) {
    instanceDir = path.join(instanceDir, config.target);
  }

  const projectFile = await utils.checkBasicConfigValidation(instanceDir);
  if (
    projectFile &&
    projectFile.inputs &&
    projectFile.inputs.runtime &&
    projectFile.inputs.runtime.toLowerCase().startsWith('nodejs')
  ) {
    cli.log('为方便您的调试，当前开启调试模式后，应用实例配置将会变更:');
    cli.log(
      '1. 当前函数实例将进入单例模式；同一时间该函数所有版本只能响应一个事件，并发超出的事件将调用失败；已预制的多个实例也会缩至单个实例'
    );
    cli.log('2. $LATEST版本执行超时时间将调整为900s');
    cli.log('3. 关闭调试模式后，上述配置将恢复');
    cli.log('以上变更只针对Node.js且版本>=10.15, 其它语言或版本不受影响');
  }

  let watcher;

  cliEventCallback = (msg, option) => {
    cli.log(msg, option && option.type === 'error' ? 'red' : 'grey');
  };
  cliEventCallback.stdout = logForwardingOutput;

  // Define a close handler, that removes any "dev" mode agents
  const closeHandler = async () => {
    // Set new close listener
    process.on('SIGINT', () => {
      cli.sessionStop('error', 'dev 模式已取消');
      process.exit();
    });

    if (watcher) {
      await watcher.close();
    }
    cli.sessionStatus('dev 模式关闭中', null, 'green');
    const deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials);
    if (await updateDeploymentStatus(cli, deployedInstance, false)) {
      cli.sessionStop('success', 'dev 模式已关闭');
      return null;
    }
    cli.sessionStop('error', '部署失败，请运行 “sls deploy” 进行重试');
    return null;
  };

  // Start CLI persistance status
  cli.sessionStart('Initializing', { closeHandler });

  await utils.login(config);

  // Presentation
  cli.logLogo();
  cli.log('Dev Mode - 项目监控中，任何变更都会通过日志输出', 'grey');
  cli.log();

  let instanceYaml = await utils.loadInstanceConfig(instanceDir, command);

  // Load Instance Credentials
  const instanceCredentials = await utils.loadInstanceCredentials(instanceYaml.stage);

  const orgUid = await chinaUtils.getOrgId();
  const sdk = new ServerlessSDK({
    context: {
      orgName: instanceYaml.org,
      traceId: uuidv4(),
      orgUid,
    },
  });

  const telemtryData = await generatePayload({ command, rootConfig: instanceYaml, userId: orgUid });
  cli.sessionStatus('Initializing', instanceYaml.name);

  // Filter configuration
  const filter = {
    stageName: instanceYaml.stage,
    appName: instanceYaml.app,
    instanceName: instanceYaml.name,
    events: [],
  };

  // User wants to receive all messages at the app level
  if (config.filter && config.filter === 'app' && filter.instanceName) {
    delete filter.instanceName;
    cli.log('Enabling filtering at the activity at the application level', 'grey');
    cli.log();
  }

  /**
   * Watch logic
   */

  let isProcessing = false; // whether there's already a deployment in progress
  let queuedOperation = false; // whether there's another deployment queued

  // Set watcher
  watcher = chokidar.watch(process.cwd(), { ignored: /\.serverless/ });

  watcher.on('ready', async () => {
    cli.sessionStatus('dev 模式开启中', null, 'green');
    // Try to stop debug mode before first time deploy
    const instanceInfo = await getInstanceInfo(sdk, instanceYaml);
    if (instanceInfo && instanceInfo.instanceStatus && instanceInfo.instanceStatus !== 'inactive') {
      const {
        state: { lambdaArn, region },
        outputs: { scf, runtime, namespace },
      } = instanceInfo;
      regionStore = region;

      let runtimeInfo = runtime;
      let namespaceInfo = namespace;
      if (!runtimeInfo && scf) {
        runtimeInfo = scf.runtime;
      }
      if (!namespaceInfo && scf) {
        namespaceInfo = scf.namespace;
      }
      if (lambdaArn && runtimeInfo && region && chinaUtils.doesRuntimeSupportDebug(runtimeInfo)) {
        functionInfoStore = {
          functionName: lambdaArn,
          namespace: namespaceInfo,
          runtime: runtimeInfo,
        };
        // FIXME: we need to call start debug method here, due to we bind stopAll function in the startTencentRemoteLogAndDebug method and the stopAll is used in stopDebug method, if we want to stop debug mode that we must has stopAll firstly
        await chinaUtils.startTencentRemoteLogAndDebug(
          functionInfoStore,
          regionStore,
          cliEventCallback
        );
        setTimeout(() => {
          chinaUtils.startTencentRemoteLogAndDebug(
            functionInfoStore,
            regionStore,
            cliEventCallback
          );
        }, 10000);
      }
    }
    const deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials);
    await updateDeploymentStatus(cli, deployedInstance, true);
    if (deployedInstance.instanceStatus === 'error') {
      telemtryData.outcome = 'failure';
      telemtryData.failure_reason = deployedInstance.deploymentError;
    }
    await storeLocally(telemtryData);
  });

  // "raw" makes sure to catch all FS events, not just file changes
  watcher.on('raw', async () => {
    // Skip if processing already and there is a queued operation
    if (isProcessing && queuedOperation) {
      return;
    }

    // If already deploying and user made more changes, queue another deploy operation to be run after the first one
    if (isProcessing && !queuedOperation) {
      queuedOperation = true;
      return;
    }

    // If it's not processin and there is no queued operation
    if (!isProcessing) {
      let deployedInstance;
      isProcessing = true;
      cli.sessionStatus('Deploying', null, 'green');
      // reload serverless component instance
      instanceYaml = await utils.loadInstanceConfig(instanceDir, command);
      deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials);
      if (queuedOperation) {
        cli.sessionStatus('Deploying', null, 'green');
        // reload serverless component instance
        instanceYaml = await utils.loadInstanceConfig(instanceDir, command);
        deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials);
      }

      await updateDeploymentStatus(cli, deployedInstance, true);
      isProcessing = false;
      queuedOperation = false;
    }
  });
};
