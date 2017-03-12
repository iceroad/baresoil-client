var _ = require('lodash')
  , assert = require('chai').assert
  , col = require('colors')
  , fmt = require('util').format
  , json = JSON.stringify
  , sinon = require('sinon')
  , ws = global.WebSocket = require('ws')
  ;


Error.StackTraceLimit = Infinity;


describe(
    'BaresoilClient (Source): "manual" connect policy tests',
    TestCore(require('../lib/BaresoilClient')));

if (!process.env.NO_MINIFIED) {
  describe(
      'BaresoilClient (Minified): "manual" connect policy tests',
      TestCore(require('../dist/BaresoilClient.min')));
}


function TestCore(BaresoilClient) {
  return function() {
    var client, connStatusLog;
    var server, serverLog, serverUrl, broadcastFn;
    var port = _.random(30000, 31000);
    var verbose = _.get(process, 'env.VERBOSE');

    function vlog() {
      if (verbose) {
        console.log.apply(this, arguments);
      }
    }

    this.slow(200);
    this.timeout(1000);

    beforeEach(function() {
      server = new ws.Server({port: port});
      serverLog = [];
      serverUrl = 'ws://localhost:' + port + '/__bs__/live';
      broadcastFn = function(message) {
        vlog('server_broadcast:', message);
        server.clients.forEach(function(client) {
          _.delay(function() {
            client.send(json(message));
          }, _.random(10));
        });
      };
      server.once('connection', function(ws) {
        ws.on('message', function(message) {
          vlog('server received:'.gray, message);
          var jsonVal = JSON.parse(message);
          server.emit('message', jsonVal);
          serverLog.push(jsonVal);
        });
      });

      client = new BaresoilClient({
        serverUrl: serverUrl,
        connectPolicy: 'immediate',
      });
      connStatusLog = [];
      client.on('connection_status', function(connStatus) {
        vlog('connection_status:'.yellow, connStatus);
        connStatusLog.push(connStatus);
      });
    });


    afterEach(function(cb) {
      serverLog.splice(0, serverLog.length);
      port++;
      client.close();
      server.close(cb);
    });


    it('should emit an "error" connection_status on no WebSocket support',
        function(cb) {
      sinon.stub(global, 'WebSocket').throws(new Error(
          'Weird and exotic platform'));
      client.on('error', function(err) {
        assert.isOk(client.getError());
        assert.strictEqual(client.getConnectionStatus(), 'error');
        assert.deepEqual(connStatusLog, ['connecting', 'error']);
        assert.strictEqual(client.getError().code, 'no_websocket_support');
        global.WebSocket.restore();
        return cb();
      });
    });

  };
}

