var _ = require('lodash')
  , assert = require('chai').assert
  , fmt = require('util').format
  , json = JSON.stringify
  , sinon = require('sinon')
  , ws = require('ws')
  ;


function vlog() {
  if (process && process.env && process.env.VERBOSE) {
    console.log(fmt.apply(this, Array.prototype.slice.call(arguments)));
  }
}


describe(
    'BaresoilClient (Source): Connecting and RPC',
    TestCore(require('../lib/BaresoilClient')));
describe(
    'BaresoilClient (Source): Reconnections',
    TestReconnection(require('../lib/BaresoilClient')));

describe(
    'BaresoilClient (Minified): Connecting and RPC',
    TestCore(require('../dist/BaresoilClient.min')));
describe(
    'BaresoilClient (Minified): Reconnections',
    TestReconnection(require('../dist/BaresoilClient.min')));



function TestCore(BaresoilClient) {
  return function() {
    var client, context = {}, port = 31580;

    this.slow(200);
    this.timeout(1000);

    function ResetServer() {
      context.server = new ws.Server({port: port});
      context.serverLog = [];
      context.broadcastFn = function(message) {
        vlog('server_send:', message);
        context.server.clients.forEach(function(client) {
          _.delay(function() {
            client.send(json(message));
          }, _.random(50));
        });
      };
      context.server.once('connection', function(ws) {
        ws.on('message', function(message) {
          vlog('server_recv:', message);
          context.serverLog.push(JSON.parse(message));
        });
      });
    }

    beforeEach(function() {
      ResetServer();
      context.client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
      });
      context.client.on('connection_status', function(connStatus) {
        context.connStatusLog.push(connStatus);
      });
      context.connStatusLog = [];
    });



    afterEach(function(cb) {
      context.client.removeAllListeners('connection_status');
      context.server.removeAllListeners('connection');
      context.client.close();
      context.connStatusLog.splice(0, context.connStatusLog.length);
      context.server.close(cb);
      port++;
    });


    it('should respect connection policy on construction', function() {
      var connectStub = sinon.stub(BaresoilClient.prototype, 'connect');
      context.client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
      });
      assert(connectStub.notCalled, 'should not call connect() by default');

      context.client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
        connectPolicy: 'immediate',
      });
      assert(connectStub.calledOnce, 'should call connect() on immediate policy');

      context.client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
        connectPolicy: 'manual',
      });
      assert(connectStub.calledOnce, 'should not call connect() on manual policy');

      connectStub.restore();
    });


    it('should connect to the test server in the right sequence', function(cb) {
      context.client.on('error', cb);
      context.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          _.delay(function() {
            assert.sameMembers(
                ['connecting', 'setup'],
                context.connStatusLog, json(context.connStatusLog));
            context.broadcastFn(['session_response', {token: 123}]);
          }, 20);
        }
        if (connStatus === 'connected') {
          assert.sameMembers(['connecting', 'setup', 'connected'], context.connStatusLog);
          assert.equal(123, context.client.sessionPacket.token);
          return cb();
        }
      });
      context.client.connect();
    });


    it('should be able to execute an RPC and return results', function(cb) {
      context.client.on('error', cb);
      context.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          _.delay(function() {
            context.broadcastFn(['session_response', {token: 123}]);
          }, 5);
        }
        if (connStatus === 'connected') {
          _.delay(function() {
            assert.equal(2, context.serverLog.length, json(context.serverLog));
            assert.equal('rpc_request', context.serverLog[1][0]);
            var rpcId = context.serverLog[1].rpcId;
            context.broadcastFn(['rpc_response', {
              rpcId: 1,
              fnResults: 456,
            }]);
          }, _.random(10, 50));
        }
        vlog('client:connection_status:' + connStatus);
      });
      context.client.run('test_function', {args: 123}, function(err, result) {
        if (err) return cb(err);
        assert.equal(456, result);
        return cb();
      });
    });

  };
}



function TestReconnection(BaresoilClient) {
  return function() {
    var client, context = {}, port = 31580;

    this.slow(4 * 1000);
    this.timeout(6 * 1000);

    function ResetServer() {
      context.server = new ws.Server({port: port});
      context.serverLog = [];
      context.broadcastFn = function(message) {
        vlog('server_send:', message);
        context.server.clients.forEach(function(client) {
          _.delay(function() {
            try {
              client.send(json(message));
            } catch(e) { }
          }, _.random(50));
        });
      };
      context.server.once('connection', function(ws) {
        ws.on('message', function(message) {
          vlog('server_recv:', message);
          context.serverLog.push(JSON.parse(message));
        });
      });
    }

    beforeEach(function() {
      ResetServer();
      context.client = new BaresoilClient({
        serverUrl: 'ws://localhost:' + port + '/__bs__/live',
      });
      context.client.on('connection_status', function(connStatus) {
        context.connStatusLog.push(connStatus);
      });
      context.connStatusLog = [];
    });


    afterEach(function(cb) {
      context.client.removeAllListeners('connection_status');
      context.server.removeAllListeners('connection');
      context.client.close();
      context.connStatusLog.splice(0, context.connStatusLog.length);
      context.server.close(cb);
    });

    it('should re-establish an aborted connection', function(cb) {
      context.client.on('error', cb);
      var pass = 1;
      context.client.on('connection_status', function(connStatus) {
        vlog('client:connection_status:' + connStatus);
        if (connStatus === 'setup') {
          _.delay(function() {
            context.broadcastFn(['session_response', {token: 123}]);
          }, _.random(10, 50));
        }
        if (connStatus === 'connected') {
          // On the first pass, restart the server.
          if (pass === 1) {
            _.delay(function() {
              // Stop the server.
              vlog('server:closing');
              context.server.close(function() {
                vlog('server:closed');
                _.delay(function() {
                  // Restart the server after a delay.
                  vlog('server:restarting');
                  ResetServer();
                }, 20);
              });
            }, _.random(10, 50));
            pass++;
            return;
          }

          // On the second pass, we have successfully reconnected.
          if (pass === 2) {
            pass++;
            assert.sameMembers(context.connStatusLog, [
              'connecting', 'setup', 'connected',
              'connecting', 'setup', 'connected',
            ]);
            return cb();
          }

          if (pass === 3) {
            return cb(new Error('Too many passes.'));
          }
        }
      });
      context.client.connect();
    });

  };
}
