var _ = require('lodash')
  , assert = require('chai').assert
  , fmt = require('util').format
  , json = JSON.stringify
  , sinon = require('sinon')
  , ws = global.WebSocket = require('ws')
  ;


Error.StackTraceLimit = Infinity;

describe(
    'BaresoilClient (Source): Reconnecting behavior',
    TestReconnection(require('../lib/BaresoilClient')));

describe(
    'BaresoilClient (Minified): Reconnecting behavior',
    TestReconnection(require('../dist/BaresoilClient.min')));


function TestReconnection(BaresoilClient) {
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

    function ResetServer() {
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
    }

    beforeEach(function() {
      ResetServer();
    });

    afterEach(function(cb) {
      serverLog.splice(0, serverLog.length);
      port++;
      server.close(cb);
    });


    it('should re-establish an aborted connection', function(cb) {
      this.timeout(5000);
      this.slow(2500);

      var client = new BaresoilClient({
        serverUrl: serverUrl,
        connectPolicy: 'immediate'
      });
      var connStatusLog = [];
      var numTimesConnected = 0;
      client.on('connection_status', function(connStatus) {
        vlog('client connection status:', connStatus);
        connStatusLog.push(connStatus);
        if (connStatus === 'setup') {
          return _.delay(function() {
            broadcastFn(['session_response', {ok: true}]);
          }, 10);
        }
        if (connStatus === 'connected') {
          // Make server drop all connections.
          if (++numTimesConnected === 2) {
            return client.close();
          }
          server.close(function() {
            _.delay(function() {
              ResetServer();
            }, 50);
          });
        }
        if (connStatus === 'offline') {
          assert.deepEqual(connStatusLog, [
            'connecting', 'setup', 'connected',
            'connecting', 'setup', 'connected', 'offline']);
          return cb();
        }
      });
    });

  };
}
