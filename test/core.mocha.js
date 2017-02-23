var _ = require('lodash')
  , assert = require('chai').assert
  , fmt = require('util').format
  , json = JSON.stringify
  , sinon = require('sinon')
  , ws = global.WebSocket = require('ws')
  ;


Error.StackTraceLimit = Infinity;


describe(
    'BaresoilClient (Source): Connecting and RPC',
    TestCore(require('../lib/BaresoilClient')));

describe(
    'BaresoilClient (Minified): Connecting and RPC',
    TestCore(require('../dist/BaresoilClient.min')));


function TestCore(BaresoilClient) {
  return function() {
    var server, broadcastFn, serverUrl;
    var serverLog = [], port = _.random(30000, 31000);
    var verbose = process && process.env && process.env.VERBOSE;

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
        vlog('server broadcasted:', message);
        server.clients.forEach(function(client) {
          _.delay(function() {
            client.send(json(message));
          }, _.random(10));
        });
      };
      server.once('connection', function(ws) {
        ws.on('message', function(message) {
          vlog('server received:', message);
          var jsonVal = JSON.parse(message);
          server.emit('message', jsonVal);
          serverLog.push(jsonVal);
        });
      });
    });


    afterEach(function(cb) {
      serverLog.splice(0, serverLog.length);
      port++;
      server.close(cb);
    });


    it('should emit an "offline" connection status on default construction',
        function(cb) {
      var client = new BaresoilClient({
        serverUrl: serverUrl,
      });
      assert.strictEqual(client.getConnectionStatus(), 'init');
      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        assert.strictEqual(connStatus, 'offline');
        assert.strictEqual(client.getConnectionStatus(), 'offline');
        return cb();
      });
    });


    it('should connect to a server if connectPolicy == "immediate"',
        function(cb) {
      var client = new BaresoilClient({
        serverUrl: serverUrl,
        connectPolicy: 'immediate'
      });
      var connStatusLog = [];
      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        connStatusLog.push(connStatus);
        if (connStatus === 'setup') {
          return _.delay(function() {
            broadcastFn(['session_response', {ok: true}]);
          }, 10);
        }
        if (connStatus === 'connected') {
          client.close();
        }
        if (connStatus === 'offline') {
          assert.deepEqual(connStatusLog, [
            'connecting', 'setup', 'connected', 'offline']);
          return cb();
        }
      });
    });


    it('should connect to a server on connect() if connectPolicy == "auto"',
        function(cb) {
      var client = new BaresoilClient({
        serverUrl: serverUrl,
      });
      var connStatusLog = [];
      var connectInvoked = false;
      var offlines = 0;
      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        connStatusLog.push(connStatus);
        if (connStatus === 'setup') {
          assert.isTrue(
              connectInvoked, 'connection established before connect()');
          return _.delay(function() {
            broadcastFn(['session_response', {ok: true}]);
          }, 10);
        }
        if (connStatus === 'connected') {
          assert.isTrue(
              connectInvoked, 'connection established before connect()');
          client.close();
        }
        if (connStatus === 'offline') {
          if (++offlines === 2) {
            assert.deepEqual(connStatusLog, [
              'offline', 'connecting', 'setup', 'connected', 'offline']);
            return cb();
          }
        }
      });
      _.delay(function() {
        connectInvoked = true;
        client.connect();
      }, 10);
    });


    it('should be able to run a handler function and return results',
        function(cb) {
      var client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
      });
      var numOfflines = 0;
      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        if (connStatus === 'setup') {
          return _.delay(function() {
            broadcastFn(['session_response', {ok: true}]);
          }, 5);
        }
        if (connStatus === 'connected') {
          _.delay(function() {
            assert.equal(2, serverLog.length);
            assert.equal('rpc_request', serverLog[1][0]);
            var rpcId = serverLog[1][1].requestId;
            broadcastFn(['rpc_response', {
              requestId: rpcId,
              result: 456,
            }]);
          }, _.random(10, 50));
        }
        if (connStatus === 'offline') {
          if (++numOfflines === 2) {
            return cb();
          }
        }
      });
      client.run('test_function', {args: 123}, function(err, result) {
        if (err) return cb(err);
        assert.equal(456, result);
        client.close();
      });
    });


    it('should be able to run a handler function and return an error',
        function(cb) {
      var client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
      });
      var numOfflines = 0;
      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        if (connStatus === 'setup') {
          return _.delay(function() {
            broadcastFn(['session_response', {ok: true}]);
          }, 5);
        }
        if (connStatus === 'connected') {
          _.delay(function() {
            assert.equal(2, serverLog.length);
            assert.equal('rpc_request', serverLog[1][0]);
            var rpcId = serverLog[1][1].requestId;
            broadcastFn(['rpc_response', {
              requestId: rpcId,
              error: {
                message: 'error, you!'
              }
            }]);
          }, _.random(10, 50));
        }
        if (connStatus === 'offline') {
          if (++numOfflines === 2) {
            return cb();
          }
        }
      });
      client.run('test_function', {args: 123}, function(err, result) {
        assert(err.stack);
        assert.equal('error, you!', err.message);
        client.close();
      });
    });


    it('should be able to receive "user_event" events from the server and ' +
       'pass them to listeners', function(cb) {
      var client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
      });
      var numOfflines = 0;
      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        if (connStatus === 'setup') {
          return _.delay(function() {
            broadcastFn(['session_response', {ok: true}]);
          }, 5);
        }
        if (connStatus === 'connected') {
          _.delay(function() {
            broadcastFn(['user_event', {
              name: 'clown_patrol',
              data: {
                carSize: 500
              }
            }]);
          }, _.random(10, 50));
        }
        if (connStatus === 'offline') {
          if (++numOfflines === 2) {
            return cb();
          }
        }
      });
      client.on('user_event', function(evtData) {
        assert.strictEqual(evtData.name, 'clown_patrol');
        assert.deepEqual(evtData.data, {
          carSize: 500
        });
        client.close();
      });
      client.connect();
    });


    it('be able to run concurrent requests for a single client', function(cb) {
      var client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
        connectPolicy: 'immediate'
      });

      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        if (connStatus === 'setup') {
          return _.delay(function() {
            broadcastFn(['session_response', {ok: true}]);
          }, 5);
        }
        if (connStatus === 'offline') {
          return cb();
        }
      });

      var responderFn = function(inMessage) {
        if (inMessage[0] === 'rpc_request') {
          var rpcRequest = inMessage[1];
          _.delay(function() {
            broadcastFn(['rpc_response', {
              requestId: rpcRequest.requestId,
              result: rpcRequest.arguments
            }]);
          }, _.random(10));
        }
      }
      server.on('message', responderFn);

      var returned = 0;
      for (var i = 0; i < 10; i++) {
        client.run('test_function', {someArg: 123}, function(err, result) {
          assert.isNotOk(err);
          assert.deepEqual(result, {someArg: 123});
          if (++returned === 10) {
            server.removeListener('message', responderFn);
            client.close();
          }
        });
      }
    });


    it('should send an argument with "session_request" after construction',
        function(cb) {
      var client = new BaresoilClient({
        serverUrl: serverUrl,
      });
      client.setSessionRequest({
        someData: 123,
      });
      server.once('message', function(inArray) {
        assert.strictEqual(inArray.length, 2);
        assert.strictEqual(inArray[0], 'session_request');
        assert.deepEqual(inArray[1], {
          someData: 123,
        });
        client.close();
        return cb();
      });
      client.connect();
    });


    it('should send an argument with "session_request" with construction',
        function(cb) {
      var client = new BaresoilClient({
        serverUrl: serverUrl,
        sessionRequest: {
          someData: 456,
        },
        connectPolicy: 'immediate',
      });
      server.once('message', function(inArray) {
        assert.strictEqual(inArray.length, 2);
        assert.strictEqual(inArray[0], 'session_request');
        assert.deepEqual(inArray[1], {
          someData: 456,
        });
        client.close();
        return cb();
      });
    });

  };
}
