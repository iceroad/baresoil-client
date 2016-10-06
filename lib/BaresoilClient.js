/**
 * @license BaresoilClient JS
 * Apache License 2.0
 * Copyright (c) 2015-16 Iceroad LLC <contact@iceroad.io>
 */


/**
 * Closure Compiler constant: whether to include verbose code
 * @define {boolean}
 */
var BARESOIL_CLIENT_INCLUDE_VERBOSE = true;


/**
 * @param {?object} options Options for the client.
 * @property {*} serverUrl Server's Websocket endpoint URL.
 * @property {*} sessionPacket The session packet to send to the server.
 * @constructor
 */
function BaresoilClient(options) {
  // Merge default and user options.
  var defaultOpt = {
    'serverUrl': (
        typeof window == 'object'
          ? window.location.origin + '/__bs__/live'
          : undefined),
    'connectPolicy': 'auto',
  };
  options = options || {};
  if (typeof options != 'object') {
    throw new Error('options must be provided as an object.');
  }
  for (var key in defaultOpt) {
    if (!(key in options)) {
      options[key] = defaultOpt[key];
    }
  }

  // Check options.
  if (!options['serverUrl']) {
    throw new Error('"serverUrl" must be specified in options.');
  }
  if (typeof options['serverUrl'] != 'string' || (
        !options['serverUrl'].match(/^https{0,1}:\/\//i) &&
        !options['serverUrl'].match(/^wss{0,1}:\/\//i))) {
    throw new Error('Invalid "serverUrl" parameter: ' + options['serverUrl']);
  }
  if (options['connectPolicy'] !== 'auto' &&
      options['connectPolicy'] !== 'immediate' &&
      options['connectPolicy'] !== 'manual') {
    throw new Error('Invalid "connect" parameter: ' + options['connectPolicy']);
  }

  // Build a bound transition matrix for the client's state machine. Each
  // function is executed as the client transitions into a new state.
  this.transitions_ = {
    'connecting': this.onStateConnecting_.bind(this),
    'setup': this.onStateSetup_.bind(this),
    'connected': this.onStateConnected_.bind(this),
    'error': this.onStateError_.bind(this),
    'offline': this.onStateOffline_.bind(this),
  };

  // Save to object fields.
  this['sessionPacket'] = options['sessionPacket'];  // public property
  this['serverUrl'] = options['serverUrl'];  // public property
  this.options_ = options;
  this.state_ = 'offline';
  this.evtHandlers_ = {};
  this.rpcCallbacks_ = {};
  this.nextRpcId_ = 1;
  this.retryIntervalMs_ = 0;
  this.outbox_ = [];

  // Check for connection initiation policy.
  if (options['connectPolicy'] === 'immediate') {
    this['connect']();
  }
}


/**
 * Mapping of Websocket CloseEvent codes to BaresoilClient error codes.
 *
 * @constant
 * @private
 */
BaresoilClient.CLOSE_EVENT_CODES = {
  1000: 'close_normal',         // CloseEvent: CLOSE_NORMAL
  1001: 'retry_later',          // CloseEvent: CLOSE_GOING_AWAY
  1002: 'protocol_error',       // CloseEvent: CLOSE_PROTOCOL_ERROR
  1003: 'protocol_error',       // CloseEvent: CLOSE_UNSUPPORTED
  1005: 'retry_later',          // CloseEvent: CLOSE_NO_STATUS
  1006: 'retry_later',          // CloseEvent: CLOSE_ABNORMAL
  1007: 'protocol_error',       // CloseEvent: Unsupported Data
  1008: 'policy_violation',     // CloseEvent: Policy Violation (generic)
  1009: 'policy_violation',     // CloseEvent: Policy Violation (size)
  1010: 'protocol_error',       // CloseEvent: Missing Extension
  1011: 'internal_error',       // CloseEvent: Internal Error
  1012: 'retry_later',          // CloseEvent: Service Restart
  1013: 'retry_later',          // CloseEvent: Try Again Later
};


/**
 * Initiates a connection to the server.
 *
 * If the `connectionPolicy` option was specified as "manual", then this
 * methodinitiates the connection sequence. It does __not__ need to be called
 * for the "auto" and "immediate" connection policies.
 *
 * @public
 * @this {BaresoilClient}
 */
BaresoilClient.prototype['connect'] = function() {
  if (this.state_ !== 'offline') {
    return;
  }
  setTimeout((function() {
    this.transitionTo_('connecting');
  }).bind(this), 0);
};

/**
 * Internal state machine: transition from the current state to a new state.
 *
 * The client starts off in the 'offline' state.
 *
 * @private
 * @this {BaresoilClient}
 * @emits BaresoilClient#connection_status
 * @param {string} toState Target state.
 * @param {*} evtData Optional event data.
 */
BaresoilClient.prototype.transitionTo_ = function(toState, evtData) {
  this.state_ = toState;
  this.transitions_[toState].call(this);
  this.emit_('connection_status', toState, evtData);
};


/**
 * Function to execute on entering state `connecting`.
 *
 * In this state, connection attempts are made periodically until one succeeds.
 *
 * @private
 * @this {BaresoilClient}
 */
BaresoilClient.prototype.onStateConnecting_ = function() {
  // Create a new Websocket, shutting down a previous one if it exists.
  this.connectStartTimeMs_ = Date.now();
  var webSocket;
  try {
    if (this.webSocket_) this.webSocket_.close();
    var serverUrl = this['serverUrl'].replace(/^http/i, 'ws');
    webSocket = this.webSocket_ = new WebSocket(serverUrl);
    webSocket.removeListener = (
        webSocket['removeListener'] || webSocket['removeEventListener']);
  } catch(e) {
    // Construction of a WebSocket can throw SECURITY_ERR exceptions.
    // Transition to an error state.
    this.error_ = new BaresoilClient['NoWebsocketSupportError'](e);
    this.transitionTo_('error');
    return;
  }

  // Wait for the connection to either open or error out.
  var onErrorFn, onOpenFn, transitionedOut = false;

  onErrorFn = (function(err) {
    // WebSocket connection failed (e.g, resource failed to load).
    if (transitionedOut) return;

    // Backoff and retry.
    this.retryIntervalMs_ = this.backoff_(this.retryIntervalMs_);
    this.retryTimeout_ = setTimeout((function() {
      webSocket.removeListener('open', onOpenFn);
      webSocket.removeListener('error', onErrorFn);
      this.onStateConnecting_.call(this);
    }).bind(this), this.retryIntervalMs_);

  }).bind(this);

  onOpenFn = (function() {
    // WebSocket connection established.
    if (transitionedOut) return;
    delete this.retryTimeout_;
    delete this.error_;
    this.retryIntervalMs_ = 0;
    webSocket.removeListener('open', onOpenFn);
    webSocket.removeListener('error', onErrorFn);
    this.transitionTo_('setup');
    transitionedOut = true;
  }).bind(this);

  webSocket.addEventListener('open', onOpenFn);
  webSocket.addEventListener('error', onErrorFn);
};


/**
 * Function to execute on entering state `setup`.
 *
 * Sends the initial "session_request" command with the session packet to the
 * server as the first command of every session.
 *
 * If the server-side `$session` handler is not defined or returns successfully
 * then a "session_response" is expected from the server. If it returns an
 * error, then an "end_connection" is expected from the server.
 *
 * At this stage in the handshake, no other message types are expected or
 * allowed.
 *
 * @private
 * @this {BaresoilClient}
 */
BaresoilClient.prototype.onStateSetup_ = function() {
  var verbose = this.options_['verbose'];
  if (verbose && BARESOIL_CLIENT_INCLUDE_VERBOSE) {
    console.log(
      'BaresoilClient: connected to', this.options_['serverUrl'],
      'in', Date.now() - this.connectStartTimeMs_, 'ms, authenticating...');
  }

  // Wait for either a server message (session_response) or an unexpected
  // connection termination ('close').
  var onCloseFn, onMessageFn, transitionedOut, killData;
  var webSocket = this.webSocket_;

  onMessageFn = (function(wsMessageEvt) {
    // Server is sending a response to the session packet.
    if (transitionedOut) return;
    try {
      var inArray = this.decodeRaw_(wsMessageEvt.data);
      var cmd = inArray[0];
      if (cmd === 'session_response') {
        // Successfully started a session.
        if (inArray.length > 1) {
          this['sessionPacket'] = inArray[1];
        }
        this.transitionTo_('connected');
        transitionedOut = true;
        webSocket.removeListener('message', onMessageFn);
        webSocket.removeListener('close', onCloseFn);
        return;
      }
      if (cmd === 'end_connection') {
        // Server is refusing us a session (reason included), close is imminent.
        this.error_ = inArray[1];
        killData = inArray[2];
        return;
      }

      throw new Error('Unknown command: ' + cmd);

    } catch(e) {
      // Garbled packet.
      console.error(
          'BaresoilClient: invalid packet from server:', wsMessageEvt.data);
      if (verbose) {
        console.error('BaresoilClient: error:', e);
      }
      this.error_ = e;
      this.transitionTo_('error');
      transitionedOut = true;
      webSocket.removeListener('message', onMessageFn);
      webSocket.removeListener('close', onCloseFn);
    }
  }).bind(this);

  onCloseFn = (function(wsCloseEvt) {
    // Connection was unexpectedly terminated.
    if (transitionedOut) return;
    var code = (
        BaresoilClient.CLOSE_EVENT_CODES[wsCloseEvt.code] || 'internal_error');
    this.error_ = new BaresoilClient['ConnectionTerminatedError'](
        code, killData ? killData.message : wsCloseEvt.reason,
        killData ? killData.retryAfter : 0);
    webSocket.removeListener('message', onMessageFn);
    webSocket.removeListener('close', onCloseFn);

    if (code === 'retry_later') {
      this.retryIntervalMs_ = this.backoff_(this.retryIntervalMs_);
      this.transitionTo_('connecting');
    } else {
      this.transitionTo_('error', this.error_);
    }
    transitionedOut = true;

  }).bind(this);



  // Send session request message and wait for response.
  webSocket.addEventListener('close', onCloseFn.bind(this));
  webSocket.addEventListener('message', onMessageFn.bind(this));
  this.sendJson_(['session_request', this.sessionPacket_ || null]);
};


/**
 * Function to execute on entering state `connected`.
 *
 * Handshake has completed.
 *
 * @private
 * @this {BaresoilClient}
 * @emits BaresoilClient#rpc_response
 * @emits BaresoilClient#handler_event
 * @emits BaresoilClient#end_connection
 */
BaresoilClient.prototype.onStateConnected_ = function() {
  var verbose = this.options_['verbose'];
  if (verbose && BARESOIL_CLIENT_INCLUDE_VERBOSE) {
    console.log(
      'BaresoilClient: session ready in',
      Date.now() - this.connectStartTimeMs_, 'ms');
  }

  var onCloseFn, onMessageFn, transitionedOut, killData;
  var webSocket = this.webSocket_;

  onMessageFn = (function(wsMessageEvt) {
    if (transitionedOut) return;
    try {
      var inArray = this.decodeRaw_(wsMessageEvt.data);
      var cmd = inArray[0];

      // Response to an RPC request.
      if (cmd === 'rpc_response') {
        var rpcResponse = inArray[1];
        var rpcId = rpcResponse['rpcId'];
        var rpcCallback = this.rpcCallbacks_[rpcId];
        if (rpcCallback) {
          delete this.rpcCallbacks_[rpcId];
          rpcCallback(rpcResponse['error'], rpcResponse['fnResults']);
        } else {
          if (verbose && BARESOIL_CLIENT_INCLUDE_VERBOSE) {
            console.warn(
              'BaresoilClient: server responded to unknown RPC', rpcId);
          }
        }
        this.emit_.apply(this, inArray);
        return;
      }

      // Server-sent event.
      if (cmd === 'handler_event') {
        this.emit_.apply(this, inArray);
        return;
      }

      // Disconnected by server.
      if (cmd === 'end_connection') {
        killData = inArray[1];
        this.emit_.apply(this, inArray);
        return;
      }

      throw new Error('Unknown command from server: ' + cmd);

    } catch(e) {
      // Garbled packet.
      console.error(
          'BaresoilClient: invalid packet from server:', wsMessageEvt.data);
      this.error_ = e;
      this.transitionTo_('error');
      transitionedOut = true;
      webSocket.removeListener('message', onMessageFn);
      webSocket.removeListener('close', onCloseFn);
    }
  }).bind(this);

  onCloseFn = (function(wsCloseEvt) {
    // Connection was unexpectedly terminated.
    if (transitionedOut) return;
    var code = (
        BaresoilClient.CLOSE_EVENT_CODES[wsCloseEvt.code] || 'internal_error');
    this.error_ = new BaresoilClient['ConnectionTerminatedError'](
        code, killData ? killData.message : wsCloseEvt.reason,
        killData ? killData.retryAfter : 0);
    webSocket.removeListener('message', onMessageFn);
    webSocket.removeListener('close', onCloseFn);

    if (code === 'retry_later') {
      this.retryIntervalMs_ = this.backoff_(this.retryIntervalMs_);
      this.transitionTo_('connecting');
    } else {
      this.transitionTo_('error', this.error_);
    }
    transitionedOut = true;
  }).bind(this);

  webSocket.addEventListener('close', onCloseFn.bind(this));
  webSocket.addEventListener('message', onMessageFn.bind(this));

  // Flush outbox.
  var outbox = this.outbox_;
  if (outbox.length) {
    var sendFn = this.sendJson_.bind(this);
    outbox.forEach(sendFn);
    outbox.splice(0, outbox.length);
  }
};



/**
 * Function to execute on entering state `error`.
 *
 * @private
 */
BaresoilClient.prototype.onStateError_ = function() {
  // Drop the connection if one exists.
  if (this.webSocket_) {
    this.webSocket_.close();
    delete this.webSocket_;
  }

  this.resetState_(this.error_);
};


/**
 * Function to execute on entering state `offline`.
 *
 * @private
 * @this {BaresoilClient}
 */
BaresoilClient.prototype.onStateOffline_ = function() {
  var verbose = this.options_['verbose'];
  if (verbose && BARESOIL_CLIENT_INCLUDE_VERBOSE) {
    console.log(
      'BaresoilClient: connection dropped after',
      Date.now() - this.connectStartTimeMs_, 'ms');
  }

  // Drop the connection if one exists.
  if (this.webSocket) {
    this.webSocket_.close();
    delete this.webSocket_;
  }

  // Cancel the connection retry timeout if one exists.
  if (this.retryTimeout_) {
    clearTimeout(this.retryTimeout_);
    delete this.retryTimeout_;
  }

  this.resetState_();
};


/**
 * Runs a server-side handler function and returns its results asynchronously
 * via callback.
 *
 * If there is currently no active connection to the server, the function call
 * is queued in `this.outbox_` until a connection is established. Once a
 * session is available, all queued commands are sent to the server.
 *
 * If the connection policy is `auto`, then calling this function will
 * automatically call connect first.
 *
 * @public
 * @param {string} fnName Server-side handler function to call.
 * @param {*} fnArg Any JSON-serializable value to pass as the function
 *                  argument.
 * @param {function(?object, *)} cb Callback function.
 */
BaresoilClient.prototype['run'] = function(fnName, fnArg, cb) {
  // Assign default options.
  if (!fnName || typeof fnName != 'string' || fnName.length > 256) {
    throw new Error('Handler function name must be a string <= 256 chars.');
  }
  if (!cb || typeof cb != 'function') {
    if (typeof fnArg == 'function') {
      // fnArg omitted, move callback over.
      cb = fnArg;
      fnArg = undefined;
    } else {
      throw new Error('Last parameter must be a callback function.');
    }
  }

  // If we're still connecting/setting up, then buffer the RPC in this.outbox_.
  // If we're in an error state, fail the request immediately.
  // If we're connected, send the RPC request to the server without buffering.
  var connStatus = this.state_;
  if (connStatus === 'error') {
    return cb(new Error(
        'BaresoilClient.run() cannot be called while in an error state.'));
  }
  if (connStatus === 'connecting' ||
      connStatus === 'setup' ||
      connStatus === 'offline' ||
      connStatus === 'reconnecting' ||
      connStatus === 'connected') {
    // Create the RPCRequest structure to send to the server.
    var rpcId = this.nextRpcId_++;
    this.rpcCallbacks_[rpcId] = cb;
    var rpcRequest = {
      'rpcId': rpcId,
      'fnName': fnName,
      'fnArgs': fnArg
    };
    var outArray = ['rpc_request', rpcRequest];

    // If we're not connected, buffer the message in `this.outbox_`.
    // Otherwise, send it out on the socket immediately.
    if (connStatus === 'connected') {
      this.sendJson_(outArray);
    } else {
      this.outbox_.push(outArray);
    }
  }

  // Auto-connect on first RPC request if the "auto" connection policy is
  // selected.
  if (connStatus === 'offline' && this.options_['connectPolicy'] === 'auto') {
    this['connect']();
  }
};


/**
 * Terminates a connection if one is open.
 *
 * Calling this method multiple times has no side effects.
 * @public
 */
BaresoilClient.prototype['close'] = function() {
  this.transitionTo_('offline');
};


/**
 * Registers a listener function for an event type emitted by BaresoilClient.
 *
 * The listener function is called on _every_ instance of the event type.
 *
 * @public
 * @param {string} evtType Event identifier, e.g. `connection_status`
 * @param {function(?object)} listenerFn Event listener function.
 */
BaresoilClient.prototype['on'] = function(evtType, listenerFn) {
  this.evtHandlers_[evtType] = this.evtHandlers_[evtType] || [];
  this.evtHandlers_[evtType].push([listenerFn, true]);  // multiple invocations
  return listenerFn;
};


/**
 * Registers a one-time listener for an event type emitted by BaresoilClient.
 *
 * The listener function is called on the _first_ instance of the event type,
 * and then automatically removed from the list of listeners.
 *
 * @public
 * @param {string} evtType Event identifier, e.g. `connection_status`
 * @param {function(?object)} listenerFn Event listener function.
 */
BaresoilClient.prototype['once'] = function(evtType, listenerFn) {
  this.evtHandlers_[evtType] = this.evtHandlers_[evtType] || [];
  this.evtHandlers_[evtType].push([listenerFn, false]);  // once only
  return listenerFn;
};


/**
 * Removes a specific listener for an event type.
 *
 * @public
 * @param {string} evtType Event identifier, e.g. `connection_status`
 * @param {function(?object)} listenerFn The same event listener function that
 *                            was supplied to either `on` or `once`.
 */
BaresoilClient.prototype['removeEventListener'] = function(evtType, listenerFn) {
  if (typeof listenerFn !== 'function') {
    throw new Error(
      'removeEventListener() must be called with a function reference.');
  }
  if (this.evtHandlers_[evtType]) {
    this.evtHandlers_[evtType] = this.evtHandlers_[evtType].filter(function(v) {
      return v !== listenerFn;
    });
  }
};


/**
 * Removes __all__ listeners for an event type.
 *
 * @public
 * @param {string} evtType Event identifier, e.g. `connection_status`
 */
BaresoilClient.prototype['removeAllListeners'] = function(evtType) {
  if (evtType) {
    delete this.evtHandlers_[evtType];
  } else {
    this.evtHandlers_ = {};
  }
};


/**
 * Returns the current (last emitted) connection status.
 *
 * @public
 */
BaresoilClient.prototype['getConnectionStatus'] = function() {
  return this.state_;
};


/**
 * Returns the current error data.
 *
 * @public
 */
BaresoilClient.prototype['getError'] = function() {
  return this.error_;
};


/**
 * Emits an event to listener functions registered with `on()` or `once()`.
 *
 * @private
 * @this {BaresoilClient}
 */
BaresoilClient.prototype.emit_ = function() {
  // The first argument is always the event type.
  // Examples: 'handler_event', 'connection_status'.
  var args = Array.prototype.slice.call(arguments);
  if (args.length < 1) {
    throw new Error('emit() requires at least one argument.');
  }
  var evtType = args[0];
  args.splice(0, 1);

  // Collect all listeners for this event type and the catch-all event type '*'.
  var listenerArray = [];
  if (this.evtHandlers_[evtType]) {
    this.evtHandlers_[evtType] = this.evtHandlers_[evtType].filter(function(v) {
      listenerArray.push(v);
      return v[1];
    });
  }
  if (this.evtHandlers_['*']) {
    this.evtHandlers_['*'] = this.evtHandlers_['*'].filter(function(v) {
      listenerArray.push(v);
      return v[1];
    });
  }

  // Cleanup.
  if (!this.evtHandlers_[evtType]) {
    delete this.evtHandlers_[evtType];
  }
  if (!this.evtHandlers_['*']) {
    delete this.evtHandlers_['*'];
  }

  // Call all listeners.
  listenerArray.forEach(function(listenFnPair) {
    listenFnPair[0].apply(this, args);
  });
};


/**
 * JSON-serializes and writes an array of native value to the socket.
 *
 * @private
 * @this {BaresoilClient}
 * @param {array} value The array of values to send.
 */
BaresoilClient.prototype.sendJson_ = function(value) {
  this.webSocket_.send(JSON.stringify(value));
};


/**
 * Decodes a JSON-serialized string into a native array.
 *
 * @private
 * @this {BaresoilClient}
 * @param {string} inStr A JSON-serialized string.
 * @throws {SyntaxError} If the input string is not a valid JSON string.
 * @returns {array} Native array.
 */
BaresoilClient.prototype.decodeRaw_ = function(inStr) {
  return JSON.parse(inStr);
};


/**
 * Reset client state by failing all outstanding RPC requests and deleting
 * outbox.
 *
 * @private
 * @this {BaresoilClient}
 * @param {object} error Error to pass to outstanding callbacks.
 */
BaresoilClient.prototype.resetState_ = function(error) {
  // Fail all outstanding RPC requests and clear RPC outbox.
  this.error_ = error;
  for (var rpcId in this.rpcCallbacks_) {
    var cb = this.rpcCallbacks_[rpcId];
    cb(error || new Error('BaresoilClient: client state reset.'));
  }
  this.rpcCallbacks_ = {};
  this.outbox_ = [];
  this.state_ = 'error';
  this.outbox_ = [];
  this.retryIntervalMs_ = 0;
};


/**
 * Computes a bounded but exponentially increasing backoff interval.
 *
 * @private
 * @static
 * @param {number} currentIntervalMs The current interval value.
 * @return {number} New interval (possibly the same as the old interval).
 */
BaresoilClient.prototype.backoff_ = function(currentIntervalMs) {
  var MIN_BACKOFF = 1 * 1000;         // 1 second
  var MAX_BACKOFF = 5 * 60 * 1000;    // 5 minutes

  // bound input.
  var i = Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, currentIntervalMs));

  // multiply input by a tasteful factor.
  i *= 1.2;

  // add uniform noise to up to 10% of value in either direction.
  var n = Math.random() * 0.2 * i - 0.1;

  // bound output and return.
  return Math.floor(
      Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, i + n)));
};


/**
 * @public
 * @constructor
 * @extends Error
 * @class BaresoilClient#NoWebsocketSupportError
 **/
BaresoilClient['NoWebsocketSupportError'] = function(ex) {
  this['code'] = 'no_websocket_support';
  this['message'] = ex.message || 'No Websocket support found.';
  this['retryAfter'] = 0;
};
BaresoilClient['NoWebsocketSupportError'].prototype = new Error();


/**
 * @public
 * @constructor
 * @extends Error
 * @class BaresoilClient#ConnectionTerminatedError
 **/
BaresoilClient['ConnectionTerminatedError'] = function(
    code, message, retryAfter) {
  this['code'] = code;
  this['message'] = message;
  this['retryAfter'] = retryAfter;
};
BaresoilClient['ConnectionTerminatedError'].prototype = new Error();


if (typeof module == 'object' && typeof require == 'function') {
  // __Node__: the `ws` module provides the WebSocket implementation, and
  // the BaresoilClient constructor is exposed as the module interface.
  WebSocket = require('ws');
  module['exports'] = BaresoilClient;
} else {
  // __Browser__: use native WebSocket implementation, and set window global
  // so that Closure Compiler does not remove it.
  window['BaresoilClient'] = BaresoilClient;
}
