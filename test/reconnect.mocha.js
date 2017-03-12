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
    'BaresoilClient (Source): reconnecting behavior',
    TestCore(require('../lib/BaresoilClient')));

if (!process.env.NO_MINIFIED) {
  describe(
      'BaresoilClient (Minified): reconnecting behavior',
      TestCore(require('../dist/BaresoilClient.min')));
}


function TestCore(BaresoilClient) {
  return function() {
    var harness = new Harness(BaresoilClient, {
      connectPolicy: 'immediate',
    });

    beforeEach(harness.beforeEach.bind(harness));
    afterEach(harness.afterEach.bind(harness));

    this.slow(4000);
    this.timeout(5000);

    it('should emit resume connection after interruptions', function(cb) {
      var connectCount = 0;
      harness.client.on('connection_status', function(connStatus) {
        if (connStatus === 'setup') {
          return harness.broadcastFn(['session_response', {ok: true}]);
        }
        if(connStatus === 'connected') {
          connectCount++;
          if (connectCount === 1) {
            // First time connect, kill the server.
            _.delay(function() {
              harness.server.close(_.noop);
            }, 50);
            // Bring it back up
            _.delay(function() {
              harness.createServer();
            }, 250);
          }
          if (connectCount === 2) {
            return cb();
          }
        }
      });
    });

  };
}

