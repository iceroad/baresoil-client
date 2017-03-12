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
    'BaresoilClient (Source): "manual" connect policy tests',
    TestCore(require('../lib/BaresoilClient')));

if (!process.env.NO_MINIFIED) {
  describe(
      'BaresoilClient (Minified): "manual" connect policy tests',
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

    it('should emit an "offline" connection status on default construction', function(cb) {
      var client = harness.client;
      assert.strictEqual(client.getConnectionStatus(), 'offline');
      client.on('connection_status', function(connStatus) {
        assert.strictEqual(connStatus, 'offline');
        assert.strictEqual(client.getConnectionStatus(), 'offline');
        assert.deepEqual(harness.connStatusLog, ['offline']);
        return cb();
      });
    });


    it('should emit an "error" event without reconnecting if failFast = true', function(cb) {
      var client = harness.client;
      var testStartTime = Date.now();

      // Shut down the server.
      harness.server.close(function() {
        assert.strictEqual(client.getConnectionStatus(), 'offline');

        // Set the failfast flag.
        client.setConfigParameter('failFast', true);

        // Wait for the error.
        client.on('error', function(error) {
          var errStr = error.toString();
          assert.isOk(errStr.match(/ECONNREFUSED/i) || errStr.match(/hang up/i));
          _.delay(function() {
            assert.deepEqual(
                harness.connStatusLog.slice(0, 3),
                ['offline', 'connecting', 'error']);
            assert.isBelow(Date.now() - testStartTime, 500, 'backoff seems to have kicked in');
            return cb();
          }, 100);
        });

        // Attempt to connect a failFast client.
        client.connect();
      });
    });


    it('should attempt backed off connections if failFast = false (default)', function(cb) {
      var client = harness.client;
      var reconnectLog = harness.reconnectLog;

      this.slow(4000);
      this.timeout(5000);

      // Shut down the server.
      harness.server.close(function() {
        // Attempt to connect a reconnecting client.
        client.connect();

        // An error is not good here, because we should be in a reconnect loop.
        client.on('error', function(error) {
          return cb(error);
        });

        // Wait for a reasonable amount of time and check reconnect logs.
        _.delay(function() {
          assert.isAbove(reconnectLog.length, 1);  // At least 2 attempts in 2 seconds
          assert.isBelow(reconnectLog.length, 4);  // Less than 4 attempts in 2 seconds
          return cb();
        }, 3000);
      });
    });

    it('should succeed at eventually connecting with backed off retries', function(cb) {
      var client = harness.client;
      var reconnectLog = harness.reconnectLog;

      this.slow(4000);
      this.timeout(5000);

      // Shut down the server.
      harness.server.close(function() {
        // Attempt to connect a reconnecting client.
        client.connect();

        _.delay(function() {
          harness.server = new ws.Server({port: harness.port});
        }, 1000);

        client.on('connection_status', function(connStatus) {
          if (connStatus === 'setup') {
            assert.isOk(reconnectLog.length);
            assert.deepEqual(harness.connStatusLog, [
                'offline', 'connecting', 'setup']);
            return cb();
          }
        });
      });
    });

  };
}

