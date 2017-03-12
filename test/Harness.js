var _ = require('lodash')
  , col = require('colors')
  , json = JSON.stringify
  , ws = global.WebSocket = require('ws')
  ;


Error.StackTraceLimit = Infinity;
var START_PORT = _.random(30000, 31000);


function vlog() {
  if (process.env.VERBOSE) {
    console.log.apply(this, arguments);
  }
}


function Harness(BaresoilClient, configOverrides) {
  this.BaresoilClient = BaresoilClient;
  this.configOverrides = configOverrides;
}

Harness.prototype.createServer = function() {
  //
  // Create test server on a random port.
  //
  var port = this.port;
  var server = this.server = new ws.Server({port: port});
  var serverLog = this.serverLog = [];
  var clientList = this.clientList = [];
  var serverUrl = this.serverUrl = 'ws://localhost:' + port + '/__bs__/live';
  this.broadcastFn = function(message) {
    vlog('server_broadcast:', json(message));
    server.clients.forEach(function(client) {
      _.delay(function() {
        client.send(json(message));
      }, _.random(10));
    });
  };
  server.once('connection', function(ws) {
    this.clientList.push(ws);
    ws.on('message', function(message) {
      vlog('server received:'.gray, message);
      var jsonVal = JSON.parse(message);
      server.emit('message', jsonVal);
      serverLog.push(jsonVal);
    });
    ws.on('close', function() {
      this.clientList = _.filter(this.clientList, function(item) {
        return item !== ws;
      });
    }.bind(this));
  }.bind(this));
  server.closeAll = function(closeEvtCode) {
    _.forEach(this.clientList, function(ws) {
      try {
        ws.close(closeEvtCode);
      } catch(e) { };
    });
  }.bind(this);

};


Harness.prototype.beforeEach = function(cb) {
  var BaresoilClient = this.BaresoilClient;

  //
  // Create server
  //
  var port = this.port = ++START_PORT;
  this.createServer();

  //
  // Create client with config overrides.
  //
  var client = this.client = new BaresoilClient(
      _.merge({}, this.configOverrides, { serverUrl: this.serverUrl }));
  var connStatusLog = this.connStatusLog = [];
  var reconnectLog = this.reconnectLog = [];
  client.on('reconnecting', function(timeoutMs) {
    vlog('reconnecting: in %s ms'.yellow, _.toString(timeoutMs).bold);
    reconnectLog.push(timeoutMs);
  });
  client.on('reconnecting', function(inMs) {
    vlog('reconnecting_in: %s'.yellow, _.toString(inMs).bold);
  });
  client.on('connection_status', function(connStatus) {
    vlog('connection_status: %s'.yellow, connStatus.bold);
    connStatusLog.push(connStatus);
  });
  client.on('protocol_error', function(error) {
    console.error('Protocol error: %s'.red, _.toString(error).bold);
  });
  client.on('transition', function(from, to) {
    vlog(
        'Transition: %s -> %s'.magenta, _
        .toString(from).bold, _.toString(to).bold);
  });

  return cb();
};


Harness.prototype.afterEach = function(cb) {
  this.client.close();
  try {
    this.server.close(cb);
  } catch(e) { return cb(); }
};


module.exports = Harness;
