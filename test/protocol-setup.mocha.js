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
    'BaresoilClient (Source): State ' + 'setup'.bold.blue,
    TestCore(require('../lib/BaresoilClient')));

if (!process.env.NO_MINIFIED) {
  describe(
      'BaresoilClient (Minified): State ' + 'setup'.bold.blue,
      TestCore(require('../dist/BaresoilClient.min')));
}


function TestCore(BaresoilClient) {
  return function() {
    var harness = new Harness(BaresoilClient, {
      connectPolicy: 'manual',
    });

    beforeEach(harness.beforeEach.bind(harness));
    afterEach(harness.afterEach.bind(harness));

    this.slow(500);
    this.timeout(1000);


    it('should authorize a connection with "session_request"', function(cb) {
      var client = harness.client;
      var broadcastFn = harness.broadcastFn;
      client.setConfigParameter('sessionRequest', {test: 123});
      client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          _.delay(function() {
            assert.deepEqual(harness.serverLog, [
              ['session_request', {test: 123}]]);
            broadcastFn(['session_response', {ok: true}]);
          }, 20);
        }
        if (connStatus === 'connected') {
          return cb();
        }
      });
      client.connect();
    });


    it('should terminate connection on a failed "session_response"', function(cb) {
      var client = harness.client;
      var broadcastFn = harness.broadcastFn;
      client.setConfigParameter('sessionRequest', {test: 123});
      harness.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          _.delay(function() {
            assert.deepEqual(harness.serverLog, [
              ['session_request', {test: 123}]]);
            broadcastFn(['session_response', {ok: false}]);
          }, 20);
        }
        if (connStatus === 'error') {
          return cb();
        }
      });
      client.connect();
    });


    it('should handle prejudiced disconnects based on CloseEvent code, 1', function(cb) {
      var client = harness.client;
      client.setConfigParameter('sessionRequest', {test: 123});
      client.connect();
      harness.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          // Kill the client with prejudice
          return harness.server.closeAll(1008);  /// 1008 = Policy Violation
        }
        if (connStatus === 'error') {
          return cb();
        }
      });
    });


    it('should handle prejudiced disconnects based on CloseEvent code, 2', function(cb) {
      var client = harness.client;
      client.setConfigParameter('sessionRequest', {test: 123});
      client.connect();
      harness.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          // Kill the client with prejudice
          return harness.server.closeAll(1002);  /// 1002 = Policy Error
        }
        if (connStatus === 'error') {
          return cb();
        }
      });
    });


    it('should handle accidental disconnects based on CloseEvent code', function(cb) {
      var client = harness.client;
      client.setConfigParameter('sessionRequest', {test: 123});
      client.connect();
      var inStateConnecting = 0;
      harness.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          // Kill the client without prejudice
          return harness.server.close(_.noop);  // Closes with 1006 = CLOSE_ABNORMAL
        }
        if (connStatus === 'connecting') {
          if (++inStateConnecting >= 2) {
            return cb();
          }
        }
      });
    });


    it('should relay "user_event" while in setup', function(cb) {
      var client = harness.client;
      client.connect();
      var inStateConnecting = 0;
      harness.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          // Emit a user event.
          return harness.broadcastFn(['user_event', {
            name: 'my best event',
            data: {test: 123},
          }]);
        }
      });
      harness.client.on('user_event', function(evtName, evtData) {
        assert.strictEqual(evtName, 'my best event');
        assert.deepEqual(evtData, {test: 123});
        return cb();
      });
    });
  };
}
