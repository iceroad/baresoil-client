/* eslint-disable */
/**
 * @license BaresoilClient JS
 * Apache License 2.0
 * Copyright (c) 2015-17 Iceroad LLC <contact@iceroad.io>
 */

/**
 * @param {?object} options Options for the client.
 * @property {*} serverUrl Server's Websocket endpoint URL.
 * @property {*} sessionRequest The session packet to send to the server.
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
    'failFast': false,
    'sessionRequest': null
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
      options['connectPolicy'] !== 'manual' &&
      options['connectPolicy'] !== 'immediate') {
    throw new Error('Invalid "connect" parameter: ' + options['connectPolicy']);
  }

  // Save option fields.
  this.sessionRequest_ = options['sessionRequest'];
  this.serverUrl_ = options['serverUrl'];
  this.connectPolicy_ = options['connectPolicy'];
  this.failFast_ = options['failFast'];

  // Reset state to pristine, initiate connection on next tick for "immediate".
  this['reset']();
  if (this.connectPolicy_ === 'immediate') {
    this['connect']();
  } else {
    this.emitDeferred_('connection_status', 'offline');
  }
}


/**
 * Reset client state to pristine state. Fail any outstanding RPC requests in
 * the process. Meant to reset from an error state.
 *
 * @public
 * @this {BaresoilClient}
 */
BaresoilClient.prototype['reset'] = function() {
  // Kill connection, fail all outstanding RPC requests.
  this.resetState_();
  this.killSocket_();
  this.abortPendingRpcs_();
};


BaresoilClient.prototype.resetState_ = function() {
  // Reset internal state.
  this.evtHandlers_ = {};         // EventEmitter listeners
  this.rpcCallbacks_ = {};        // In-flight RPC request callbacks
  this.nextRpcId_ = 1;            // For matching requests with responses
  this.retryIntervalMs_ = 0;      // Retry timeout for next connection fail
  this.outbox_ = [];              // Buffered RPC requests waiting for a connection
  this.state_ = 'offline';        // Initial state machine state
}


BaresoilClient.prototype.abortPendingRpcs_ = function() {
  for (var rpcId in this.rpcCallbacks_) {
    var cb = this.rpcCallbacks_[rpcId];
    delete this.rpcCallbacks_[rpcId];
    var err = new Error('Connection to server was dropped.');
    err.code = 'connection_dropped';
    cb(err);
  }
}


BaresoilClient.prototype.killSocket_ = function() {
  try {
    this.webSocket_.close();
  } catch(e) { }
  delete this.webSocket_;
};


BaresoilClient.prototype.createSocket_ = function() {
  var serverUrl = this.serverUrl_.replace(/^http/i, 'ws');
  var webSocket = this.webSocket_ = new WebSocket(serverUrl);
  webSocket.removeListener = (
      webSocket['removeListener'] || webSocket['removeEventListener']);
  return webSocket;
};


BaresoilClient.prototype.transitionTo_ = function(toState, error) {
  this.state_ = toState;
  this.error_ = error;
  if (toState !== this.lastEmitted_) {
    this.emit_('connection_status', toState);
    this.lastEmitted_ = toState;
  }
  if (error) {
    this.abortPendingRpcs_();
    this.killSocket_();
    this.emit_('error', error);
  }
}

/**
 * Initiates a connection to the server.
 *
 * This function does __not__ need to be called if the `connectPolicy` option
 * is "auto".
 *
 * @public
 * @this {BaresoilClient}
 */
BaresoilClient.prototype['connect'] = function() {
  if (this.state_ !== 'offline') {
    console.warn('Ignoring connect() call in state:', this.state_);
    return;
  }

  return setTimeout(function() {
    this.transitionTo_('connecting');

    var webSocket;

    // Construction of a WebSocket can throw SECURITY_ERR exceptions in the
    // browser, or undefined symbol errors in node if global.WebSocket is not set.
    try {
      this.webSocket_ = webSocket = this.createSocket_();
    } catch(e) {
      var error = new BaresoilClient['NoWebsocketSupportError'](e);
      return this.transitionTo_('error', error);
    }

    // Listen for WebSocket errors.
    webSocket.addEventListener('error', this.onError_.bind(this));

    // Listen for WebSocket message events. These are incoming messages from the
    // server.
    webSocket.addEventListener('message', this.onMessage_.bind(this));

    // Listen for WebSocket close events. These will either invoke the reconnect
    // logic or move to an error state.
    webSocket.addEventListener('close', this.onClose_.bind(this));

    // Listen for WebSocket open events.
    webSocket.addEventListener('open', this.onOpen_.bind(this));

  }.bind(this), 10);
};


BaresoilClient.prototype.onOpen_ = function() {
  this.transitionTo_('setup');
  this.sendJson_(['session_request', this.sessionRequest_ || null]);
};


BaresoilClient.prototype.onClose_ = function(wsCloseEvt) {
  var code = (
      BaresoilClient.CLOSE_EVENT_CODES[wsCloseEvt.code] || 'internal_error');
  this.abortPendingRpcs_();
  //
  // If the close was accidental, transition to "connecting".
  // If the close was with prejudice, transition to "error".
  //
  if (code === 'retry_later') {
    this.killSocket_();
    return this.transitionTo_('connecting');
  }

  if (code === 'close_normal') {
    this.killSocket_();
    return this.transitionTo_('offline');
  }

  this.error_ = new BaresoilClient['ConnectionTerminatedError'](
      code, wsCloseEvt.reason, wsCloseEvt);
  return this.transitionTo_('error', this.error_);
};


BaresoilClient.prototype.onMessage_ = function(wsMessageEvt) {
  try {
    var inArray = this.decodeRaw_(wsMessageEvt.data);
    var cmd = inArray[0];
    this.emit_('incoming_message', inArray);
  } catch(e) {
    return this.emit_('protocol_error', e);
  }

  //
  // Handle "session_response"
  //
  if (cmd === 'session_response') {
    var sessionResponse = inArray[1];
    if (sessionResponse.ok) {
      this.sessionResponse_ = sessionResponse.result;
      this.flushOutbox_();
      return this.transitionTo_('connected');
    } else {
      this.error_ = new Error(sessionResponse.error);
      return this.transitionTo_('error', this.error_);
    }
  }

  //
  // "user_event" messages are relayed.
  //
  if (cmd === 'user_event') {
    this.emit_.apply(this, [inArray[0], inArray[1].name, inArray[1].data]);
    return;
  }

  //
  // Handle "rpc_response" messages.
  //
  if (cmd === 'rpc_response') {
    var rpcResponse = inArray[1];
    var rpcId = rpcResponse['requestId'];
    var rpcCallback = this.rpcCallbacks_[rpcId];
    if (rpcCallback) {
      delete this.rpcCallbacks_[rpcId];
      var errObj;
      if (typeof rpcResponse['error'] === 'object') {
        errObj = new Error();
        errObj.message = rpcResponse['error']['message'];
        errObj.code = rpcResponse['error']['code'];
      }
      rpcCallback.call(this, errObj, rpcResponse['result']);
    }
    this.emit_.apply(this, inArray);
    return;
  }

  return this.emit_(
      'protocol_error',
      'Unknown message from server: ' + wsMessageEvt.data);
};


BaresoilClient.prototype.onError_ = function(err) {
  // If the "failFast" option is set, then transition to error without
  // attempting to reconnect.
  if (this.failFast_) {
    return this.transitionTo_('error', err);
  }

  // Backoff and retry in an infinite loop. Note: will not work if there is
  // another dot-com bubble bust.
  this.retryIntervalMs_ = this.backoff_(this.retryIntervalMs_);
  this.emit_('reconnecting', this.retryIntervalMs_);
  this.killSocket_();
  this.retryTimeout_ = setTimeout((function() {
    this.state_ = 'offline';
    this['connect']();
  }).bind(this), this.retryIntervalMs_);
};





/**
 * Terminates a connection if one is open.
 *
 * Calling this method multiple times has no side effects.
 * @public
 */
BaresoilClient.prototype['close'] = function() {
  try {
    this.webSocket_.close();
  } catch(e) { }
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

  if (connStatus === 'connected') {
    return this.makeRpcRequest_(fnName, fnArg, cb);
  }

  if (connStatus === 'offline' ||
      connStatus === 'setup' ||
      connStatus === 'connecting') {
    this.outbox_.push([fnName, fnArg, cb]);
  }

  // Auto-connect on first RPC request if the "auto" connection policy is
  // selected.
  if (connStatus === 'offline' && this.connectPolicy_ === 'auto') {
    this.connect();
  }
};


BaresoilClient.prototype.makeRpcRequest_ = function(fnName, fnArg, cb) {
  // Create the RPCRequest structure to send to the server.
  var rpcId = this.nextRpcId_++;
  var rpcRequest = {
    'requestId': rpcId,
    'function': fnName,
    'arguments': fnArg
  };
  var outArray = ['rpc_request', rpcRequest];

  try {
    this.sendJson_(outArray);
  } catch(e) {
    return cb(e);
  }

  this.rpcCallbacks_[rpcId] = cb;
}


BaresoilClient.prototype.flushOutbox_ = function() {
  var outbox = this.outbox_ ;
  for (var i = 0; i < outbox.length; i++) {
    var item = outbox[i];
    this.makeRpcRequest_.apply(this, item);
  }
}


/**
 * Gets current connection status.
 *
 * @public
 * @this {BaresoilClient}
 */
BaresoilClient.prototype['getConnectionStatus'] = function() {
  return this.state_;
};


/**
 * Sets a configuration parameter.
 *
 * @public
 * @this {BaresoilClient}
 */
BaresoilClient.prototype['setConfigParameter'] = function(param, value) {
  if (param === 'failFast') return this.failFast_ = value;
  if (param === 'serverUrl') return this.serverUrl_ = value;
  if (param === 'sessionRequest') return this.sessionRequest_ = value;
  if (param === 'connectPolicy') return this.connectPolicy_ = value;
};




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
  var evtArgs = args.slice(1);

  // Collect all listeners for this event type and the catch-all event type '*'.
  var listenerArray = [];
  if (this.evtHandlers_[evtType]) {
    // Filter out once-only events after adding them to listenerArray.
    this.evtHandlers_[evtType] = this.evtHandlers_[evtType].filter(function(p) {
      listenerArray.push([p[0], evtArgs]);
      return p[1];  // true = allow multiple listener invocations
    });
  }
  if (this.evtHandlers_['*']) {
    this.evtHandlers_['*'] = this.evtHandlers_['*'].filter(function(p) {
      listenerArray.push([p[0], args]);
      return p[1];  // true = allow multiple listener invocations
    });
  }

  // Call all listeners.
  var ctx = this;
  listenerArray.forEach(function(listenFnPair) {
    listenFnPair[0].apply(ctx, listenFnPair[1]);
  });
};


BaresoilClient.prototype.emitDeferred_ = function() {
  var args = Array.prototype.slice.call(arguments);
  var ctx = this;
  setTimeout(function() {
    ctx.emit_.apply(ctx, args);
  }, 0);
};


/**
 * JSON-serializes and writes an array of native value to the socket.
 *
 * @private
 * @this {BaresoilClient}
 * @param {array} value The array of values to send.
 */
BaresoilClient.prototype.sendJson_ = function(value) {
  this.emit_('outgoing_message', value);
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
 * Computes a bounded but exponentially increasing backoff interval.
 *
 * @private
 * @static
 * @param {number} currentIntervalMs The current interval value.
 * @return {number} New interval (possibly the same as the old interval).
 */
BaresoilClient.prototype.backoff_ = function(currentIntervalMs) {
  var MIN_BACKOFF = 1 * 1000;          // 1 second
  var MAX_BACKOFF = 30 * 60 * 1000;    // 30 minutes

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
    code, message, wsCloseEvt) {
  this['code'] = code;
  this['message'] = message;
  this['wsCloseEvt'] = wsCloseEvt;
};
BaresoilClient['ConnectionTerminatedError'].prototype = new Error();


if (typeof module === 'object') {
  module['exports'] = BaresoilClient;
} else {
  window['BaresoilClient'] = BaresoilClient;
}
