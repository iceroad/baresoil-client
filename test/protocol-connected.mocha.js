var _ = require('lodash')
  , assert = require('chai').assert
  , col = require('colors')
  , fmt = require('util').format
  , json = JSON.stringify
  , sinon = require('sinon')
  , ws = global.WebSocket = require('ws')
  , Harness = require('./Harness')
  ;



describe(
    'BaresoilClient (Source): State ' + 'connected'.bold.blue,
    TestCore(require('../lib/BaresoilClient')));

if (!process.env.NO_MINIFIED) {
  describe(
      'BaresoilClient (Minified): State ' + 'connected'.bold.blue,
      TestCore(require('../dist/BaresoilClient.min')));
}


function TestCore(BaresoilClient) {
  return function() {
    var harness = new Harness(BaresoilClient, {
      connectPolicy: 'immediate',
    });

    beforeEach(harness.beforeEach.bind(harness));
    afterEach(harness.afterEach.bind(harness));

    this.slow(500);
    this.timeout(1000);


    it('should be able to run a handler function and return results', function(cb) {
      var client = harness.client;
      var broadcastFn = harness.broadcastFn;
      var serverLog = harness.serverLog;

      client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          return broadcastFn(['session_response', {ok: true}]);
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
      });
      client.run('test_function', {args: 123}, function(err, result) {
        if (err) return cb(err);
        assert.equal(456, result);
        return cb();
      });
    });

    it('should be able to run a handler function and return an error', function(cb) {
      var client = harness.client;
      var broadcastFn = harness.broadcastFn;
      var serverLog = harness.serverLog;

      client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          return broadcastFn(['session_response', {ok: true}]);
        }
        if (connStatus === 'connected') {
          _.delay(function() {
            assert.equal(2, serverLog.length);
            assert.equal('rpc_request', serverLog[1][0]);
            var rpcId = serverLog[1][1].requestId;
            broadcastFn(['rpc_response', {
              requestId: rpcId,
              error: {
                message: 'no go, buddy',
                code: 'bad_call',
              },
            }]);
          }, _.random(10, 50));
        }
      });
      client.run('test_function', {args: 123}, function(err, result) {
        assert.isOk(err);
        assert.isNotOk(result);
        assert.strictEqual('bad_call', err.code);
        assert.strictEqual('no go, buddy', err.message);
        return cb();
      });
    });


    it('should be able to relay "user_event" events from the server', function(cb) {
      var client = harness.client;
      var broadcastFn = harness.broadcastFn;
      var serverLog = harness.serverLog;

      client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          return broadcastFn(['session_response', {ok: true}]);
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
      });

      client.on('user_event', function(evtName, evtData) {
        assert.strictEqual(evtName, 'clown_patrol');
        assert.deepEqual(evtData, {
          carSize: 500
        });
        return cb();
      });
    });


    it('be able to run concurrent requests for a single client', function(cb) {
      var client = harness.client;
      var server = harness.server;
      var broadcastFn = harness.broadcastFn;
      var serverLog = harness.serverLog;

      client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          server.on('message', echoResponderFn);
          return broadcastFn(['session_response', {ok: true}]);
        }
      });

      var echoResponderFn = function(inMessage) {
        if (inMessage[0] === 'rpc_request') {
          var rpcRequest = inMessage[1];
          _.delay(function() {
            broadcastFn(['rpc_response', {
              requestId: rpcRequest.requestId,
              result: rpcRequest.arguments
            }]);
          }, 5);
        }
      }

      var returned = 0;
      for (var i = 0; i < 10; i++) {
        client.run('test_function', {someArg: 123}, function(err, result) {
          assert.isNotOk(err);
          assert.deepEqual(result, {someArg: 123});
          if (++returned === 10) {
            return cb();
          }
        });
      }
    });


    it('should abort outstanding RPCs on connection close', function(cb) {
      var client = harness.client;
      var server = harness.server;
      var broadcastFn = harness.broadcastFn;
      var serverLog = harness.serverLog;

      this.slow(750);
      this.timeout(1000);

      client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          _.delay(function() {
            server.close(_.noop);
          }, 500);
          return broadcastFn(['session_response', {ok: true}]);
        }
      });

      var returned = 0;
      for (var i = 0; i < 10; i++) {
        client.run('test_function', {someArg: 123}, function(err, result) {
          assert.isOk(err);
          assert.match(err.message, /dropped/i);
          assert.strictEqual(err.code, 'connection_dropped');
          assert.isNotOk(result);
          if (++returned === 10) {
            return cb();
          }
        });
      }
    });

  };
}
