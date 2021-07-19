'use strict';

/*
 * SERVERLESS COMPONENTS: CLI
 */

const os = require('os');
const chalk = require('chalk');
const ansiEscapes = require('ansi-escapes');
const stripAnsi = require('strip-ansi');
const figures = require('figures');
const prettyoutput = require('prettyoutput');
const chokidar = require('chokidar');
const { version } = require('../../package.json');
const { isChinaUser } = require('./utils');

// CLI Colors
const grey = chalk.dim;
const white = (str) => str; // we wanna use the default terimanl color, so we just return the string as is with no color codes
const whiteBold = chalk.bold;
const { green } = chalk;
const red = chalk.rgb(255, 99, 99);
const blue = chalk.rgb(199, 232, 255);

/**
 * Utility - Sleep
 */
const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait));

/**
 * CLI
 * - Controls the CLI experience in the framework.
 * - Once instantiated, it starts a single, long running process.
 */
class CLI {
  constructor(config) {
    // Defaults
    this._ = {};
    this._.entity = 'Serverless';
    this._.status = 'Initializing';
    this._.statusColor = grey;
    this._.lastStatus = null;
    this._.debug = config.debug || false;
    this._.timer = config.timer || false;
    this._.ci = config.ci || false;
    this._.timerStarted = Date.now();
    this._.timerSeconds = 0;
    this._.loadingDots = '';
    this._.loadingDotCount = 0;
  }

  /**
   * Renders a persistent, animated status bar in the CLI which remains visible until 'sessionClose()' is called.  Useful for deployments and other long-running processes where the user needs to know something is happening and what that is.
   * @param {string} status Update the status text in the status bar.
   * @param {string} options.timer Shows a timer for how long the session has been running.
   * @param {function} options.closeHandler A function to call when the session is closed.
   */
  sessionStart(status, options = {}) {
    // Prevent commands from accidently starting multiple sessions
    if (this._.sessionActive) {
      return null;
    }

    if (options.timer) {
      this._.timer = true;
    } else {
      this._.timer = false;
    }

    // Hide cursor, to keep it clean
    process.stdout.write(ansiEscapes.cursorHide);

    if (this._.debug) {
      // Create a white space immediately
      this.log();
    }

    // Start counting seconds
    setInterval(() => {
      this._.timerSeconds = Math.floor((Date.now() - this._.timerStarted) / 1000);
    }, 1000).unref();

    // Set default close handler, if one was not provided
    if (!options.closeHandler) {
      const self = this;
      options.closeHandler = async () => {
        return self.sessionStop('cancel', 'Canceled');
      };
    }

    // Set Event Handler: Control + C to cancel session
    process.on('SIGINT', async () => {
      await options.closeHandler();
      process.exit();
    });

    if (status) {
      this.sessionStatus(status);
    }

    this._.sessionActive = true;

    // Start render engine
    return this._renderEngine();
  }

  /**
   * Stops rendering the persistent status bar in the CLI with a final status message.
   * @param {string} reason This tells the status bar how to display its final message. Can be 'error', 'cancel', 'close', 'success', 'silent'.
   * @param {string || error} messageOrError Can be a final message to the user (string) or an error object.
   */
  sessionStop(reason, messageOrError = 'Closed') {
    // Clear any existing content
    process.stdout.write(ansiEscapes.cursorLeft);
    process.stdout.write(ansiEscapes.eraseDown);

    // Set color
    let color = white;
    if (reason === 'close') {
      color = white;
    }
    if (reason === 'success') {
      color = green;
    }
    if (reason === 'error' || reason === 'cancel') {
      color = red;
    }

    // Render error
    if (reason === 'error') {
      this.logError(messageOrError, { timer: this._.timerSeconds });
      process.exitCode = 1;
    } else if (reason !== 'silent') {
      // Silent is used to skip the "Done" message
      // Write content
      this.log();
      let content = '';
      if (this._.timer) {
        content += `${`${this._.timerSeconds}s`}`;
        content += ` ${figures.pointerSmall} `;
      }
      content += `${this._.entity} `;
      content += `${figures.pointerSmall} ${messageOrError.message || messageOrError}`; // In case an error object was passed in
      process.stdout.write(color(content));
    }

    // Put cursor to starting position for next view
    console.log(os.EOL);
    process.stdout.write(ansiEscapes.cursorLeft);
    process.stdout.write(ansiEscapes.cursorShow);

    this._.sessionActive = false;
  }

  /**
   * Is the persistent status bar in the CLI active
   */
  isSessionActive() {
    return this._.sessionActive;
  }

  /**
   * Set the status of the persistent status display.
   * @param {string} status The text the status should show.  Keep this short.
   * @param {string} entity The entitiy (e.g. Serverless) that is sending the message.
   * @param {string} statusColor 'green', 'white', 'red', 'grey'
   */
  sessionStatus(status = null, entity = null, statusColor = null) {
    this._.status = status || this._.status;
    this._.entity = entity || this._.entity;
    if (statusColor === 'green') {
      statusColor = green;
    }
    if (statusColor === 'red') {
      statusColor = red;
    }
    if (statusColor === 'white') {
      statusColor = white;
    }
    this._.statusColor = statusColor || grey;
  }

  /**
   * Log an error and optionally a stacktrace
   * @param {error} error An instance of the Error class
   * @param {string} error.documentation A link to documentation
   * @param {boolean} error.support Defaults to true and shows a support link.  If false, hides link.
   * @param {boolean} error.chat Defaults to true and shows a chat link.  If false, hides link.
   * @param {boolean} options.hideEntity Hides "Serverless › " at the beginning of the error message.
   * @param {string} options.timer Include the timer in the error message "16s › ".  Value must be a string or number integer of seconds.
   */
  logError(error = {}, options = {}) {
    // If no argument, skip
    if (!error || error === '') {
      return null;
    }

    if (typeof error === 'string') {
      error = { message: error };
    }

    // Add default helpful info
    error.name = error.name || 'Unknown Error';

    if (!isChinaUser()) {
      if (error.documentation !== false) {
        error.documentation = error.documentation
          ? `  Documentation: ${error.documentation} ${os.EOL}`
          : `  Documentation: https://github.com/serverless/components ${os.EOL}`;
      }
      if (error.support !== false) {
        error.support = `  Support: https://app.serverless.com/support ${os.EOL}`;
      }
      if (error.chat !== false) {
        error.chat = `  Slack: https://www.serverless.com/slack/ ${os.EOL}`;
      }
    } else {
      if (error.documentation !== false) {
        error.documentation = error.documentation
          ? `  帮助文档: ${error.documentation} ${os.EOL}`
          : `  帮助文档: https://www.serverless.com/cn/framework/docs/ ${os.EOL}`;
      }
      if (error.support !== false) {
        error.support = `  BUG提交: https://github.com/serverless/serverless-tencent/issues ${os.EOL}`;
      }
      if (error.chat !== false) {
        error.chat = `  问答社区: https://github.com/serverless/serverless-tencent/discussions ${os.EOL}`;
      }
    }

    // Clear any existing content
    process.stdout.write(ansiEscapes.eraseDown);

    // Add space
    console.log('');

    // Render stack trace (if debug is on)
    this.logErrorStackTrace(error.stack);

    let content;

    if (options.hideEntity) {
      content = `${error.message} ${os.EOL}`;
    } else {
      content = `${this._.entity} ${figures.pointerSmall} ${error.message} ${os.EOL}`;
    }

    // Add timer seconds, if included
    if (options.timer) {
      content = `${options.timer}s ${figures.pointerSmall} ${content}`;
    }

    // Add additional space
    content += os.EOL;

    // Add helpful error info
    if (error.documentation) {
      content += error.documentation;
    }
    if (error.support) {
      content += error.support;
    }
    if (error.chat) {
      content += error.chat;
    }

    // Write to terminal
    process.stdout.write(red(content));

    // Put cursor to starting position for next view
    process.stdout.write(ansiEscapes.cursorLeft);

    return null;
  }

  /**
   * Log an error's stack trace
   * @param {error} error An instance of the Error class
   */
  logErrorStackTrace(errorStack) {
    if (!this._.debug || !errorStack) {
      return null;
    }

    // If no argument, skip
    if (!errorStack) {
      return null;
    }

    // Clear any existing content
    process.stdout.write(ansiEscapes.eraseDown);

    // Render stack trace
    console.log('', red(errorStack));
    // Put cursor to starting position for next view
    process.stdout.write(ansiEscapes.cursorLeft);
    // Add additional space
    console.log();

    return null;
  }

  logWarning(error = {}) {
    console.log(`Serverless: ${chalk.yellow(error.message)}`);
    process.exit();
  }

  /**
   * TODO: REMOVE THIS.  SHOULD NOT BE IN HERE.  THIS IS NOT A GENERAL UTILS LIBRARY
   * Watch
   * - Watches the specified directory with the given options
   */
  watch(dir, opts) {
    this.watcher = chokidar.watch(dir, opts);
  }

  /**
   * TODO: REMOVE THIS.  SHOULD NOT BE IN HERE.  THIS IS NOT A GENERAL UTILS LIBRARY
   */
  debugMode() {
    return this._.debug;
  }

  /**
   * Log
   * - Render log statements cleanly
   */
  log(msg, color = null) {
    // If no message and debug mode is enabled, do nothing.
    if (!msg && this._.debug) {
      return null;
    }

    // Render line break if "msg" is blank
    if (!msg) {
      console.log();
      return null;
    }

    // Don't use colors in debug mode
    if (color && this._.debug) {
      color = null;
    }

    // Clear any existing content
    process.stdout.write(ansiEscapes.eraseDown);

    // Write log
    if (typeof msg === 'string') {
      msg = `${msg}\n`;
      if (!color || color === 'white') {
        process.stdout.write(white(msg));
      }
      if (color === 'whiteBold') {
        process.stdout.write(whiteBold(msg));
      }
      if (color === 'grey') {
        process.stdout.write(grey(msg));
      }
      if (color === 'red') {
        process.stdout.write(red(msg));
      }
      if (color === 'green') {
        process.stdout.write(green(msg));
      }
      if (color === 'blue') {
        process.stdout.write(blue(msg));
      }
    } else {
      console.log(msg);
    }

    // Put cursor to starting position for next view
    process.stdout.write(ansiEscapes.cursorLeft);

    return null;
  }

  /**
   * Log Serverless Framework Logo
   */
  logLogo() {
    let logo = os.EOL;
    logo += 'serverless';
    logo += red(' ⚡');
    logo += 'components';

    if (process.env.SERVERLESS_PLATFORM_STAGE === 'dev') {
      logo += grey(' (dev)');
    }

    this.log(logo);
  }

  /**
   * Log Serverless Framework Registry Logo
   */
  logRegistryLogo(text) {
    let logo = os.EOL;
    logo += white('serverless');
    logo += red(' ⚡');
    logo += white('registry');

    if (process.env.SERVERLESS_PLATFORM_STAGE === 'dev') {
      logo += grey(' (dev)');
    }

    if (text) {
      logo += text;
    }
    this.log(logo);
  }

  /**
   * Log Serverless Framework Components Version
   */
  logVersion() {
    this.logLogo();
    this.log();
    this.log(`components version: ${version}`);
    this.log();
  }

  logAdvertisement() {
    this.logLogo();
    this.log();
    let ad = grey(
      'This is a Serverless Framework Component, a premium development experience. Run "serverless login" to use it for free with these features:'
    );
    ad += os.EOL;
    ad = ad + os.EOL + grey('  • Instant Deployments');
    ad = ad + os.EOL + grey('  • Real-Time Logs In Your CLI');
    ad = ad + os.EOL + grey('  • State Storage, Secrets Management');
    ad = ad + os.EOL + grey('  • And More: https://github.com/serverless/components');
    ad += os.EOL;
    ad =
      ad +
      os.EOL +
      grey(
        'Note - This is an optional SaaS feature, where our hosted cloud engine can access your credentials and code alike a CI/CD product. Learn more here: https://github.com/serverless/components#security-considerations'
      );
    this.log(ad);
  }

  /**
   * Debug
   * - Render debug statements cleanly
   */
  debug(msg) {
    if (!this._.debug || !msg) {
      return;
    }

    // Clear any existing content
    process.stdout.write(ansiEscapes.eraseDown);

    console.log(`${msg}`);

    // Put cursor to starting position for next view
    process.stdout.write(ansiEscapes.cursorLeft);
  }

  /**
   * Outputs
   * - Render outputs cleanly.
   */
  logOutputs(outputs, indent = 0) {
    if (!outputs || typeof outputs !== 'object' || Object.keys(outputs).length === 0) {
      this.sessionStop('done', 'Success');
    }
    // Clear any existing content
    process.stdout.write(ansiEscapes.eraseDown);
    process.stdout.write(
      white(
        prettyoutput(
          outputs,
          {
            colors: {
              keys: 'bold',
              dash: null,
              number: null,
              string: null,
              true: null,
              false: null,
            },
            maxDepth: 10,
          },
          indent
        )
      )
    );
  }

  /**
   * Handles the rendering of the the persistent status bar in the CLI. Repetitively updates the CLI view on a regular interval
   */
  async _renderEngine() {
    if (!this._.sessionActive) return null;
    /**
     * Debug Mode
     */
    if (this._.debug) {
      // Print Status
      if (this._.status !== this._.lastStatus) {
        this.log(`${this._.status}...`);
        this._.lastStatus = `${this._.status}`;
      }
    }

    /**
     * CI Mode
     */
    if (this._.ci) {
      if (this._.status === 'Initializing' && this._.status !== this._.lastStatus) {
        this.log('enable CI Mode');
        this._.lastStatus = `${this._.status}`;
      }
    }

    /**
     * Non-Debug and Non CI Mode
     */
    if (!this._.debug && !this._.ci) {
      // Update active dots
      if (this._.loadingDotCount === 0) {
        this._.loadingDots = '.';
      } else if (this._.loadingDotCount === 2) {
        this._.loadingDots = '..';
      } else if (this._.loadingDotCount === 4) {
        this._.loadingDots = '...';
      } else if (this._.loadingDotCount === 6) {
        this._.loadingDots = '';
      }
      this._.loadingDotCount++;
      if (this._.loadingDotCount > 8) {
        this._.loadingDotCount = 0;
      }

      // Clear any existing content
      process.stdout.write(ansiEscapes.eraseDown);

      // Write status content
      console.log();
      let content = '';
      if (this._.timer) {
        content += `${this._.statusColor(`${this._.timerSeconds}s`)} `;
        content += `${this._.statusColor(figures.pointerSmall)} `;
      }
      content += `${this._.statusColor(this._.entity)} `;
      content += `${this._.statusColor(figures.pointerSmall)} ${this._.statusColor(this._.status)}`;
      content += ` ${this._.statusColor(this._.loadingDots)}`;
      process.stdout.write(content);
      console.log();

      // Put cursor to starting position for next view
      const startingPosition = this._getRelativeVerticalCursorPosition(content);
      process.stdout.write(ansiEscapes.cursorUp(startingPosition));
      process.stdout.write(ansiEscapes.cursorLeft);
    }

    await sleep(100);
    return this._renderEngine();
  }

  /**
   * Get Relative Vertical Cursor Position
   * Get cursor starting position according to terminal & content width
   */
  _getRelativeVerticalCursorPosition(contentString) {
    const base = 1;
    const terminalWidth = process.stdout.columns;
    const contentWidth = stripAnsi(contentString).length;
    const nudges = Math.ceil(Number(contentWidth) / Number(terminalWidth));
    return base + nudges;
  }
}

module.exports = CLI;
