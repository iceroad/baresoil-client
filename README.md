# BaresoilClient Javascript

This is the reference Javascript Baresoil client library for all Javascript
environments (i.e., node, browser, and webviews). It allows a web application
to access a server-side API of _handler functions_ over a real-time, encrypted,
bi-directional Websocket connection. It also emits, using a standard
node-style _EventEmitter_ interface, any events that the handler functions
may send back to the client.

The Javascript client library exports a single class called `BaresoilClient`.
Applications must first create an instance of BaresoilClient, which handles
establishing the Websocket connection when necessary, and reconnecting on
disconnects.

## Requirements

  * In the browser
    * native WebSocket support (i.e., IE 10+, Android Kitkat 4.4+, Firefox 11+, Chrome 16+, Safari 7+, Cordova). In mid-2016, this includes [91% of clients](http://caniuse.com/#feat=websockets) in the wild.

  * On the server
    * `node.js` version v6.3.4 or greater

## Installation and Usage

There is more than one way to get access to the `BaresoilClient` class in your application code. Pick one of the methods below, depending on your development environment.

### 1. As a standalone library

The entire library is self-contained in a single, readable file, `lib/BaresoilClient.js`.
This script has no dependencies and can be included via a script tag in HTML
files, or directly into a source bundle. It defines a global constructor called
`BaresoilClient`.

For a minified build, use `dist/BaresoilClient.min.js` instead.

### 2. As an npm package

Add the project as a dependency to **package.json** by running the following command.

    npm install --save baresoil-client

In the application:

    var BaresoilClient = require('baresoil-client');

    var bsClient = new BaresoilClient();


### 3. As an ES6 module (with Babel)

Install `baresoil-client` into your project's dependencies.

  `npm install --save baresoil-client`

In the application:

    import BaresoilClient from 'baresoil-client'

    const bsClient = new BaresoilClient()


## Quickstart

This is an ES5 snippet that demonstrates creating an instance of `BaresoilClient` and
running a server-side handler function called `some_function` with an argument. Any
_error_ or _connection_status_ events are logged to the console, and any _user events_
sent by the server-side handlers are captured.

    var client = new BaresoilClient();
    client.on('error', console.error);
    client.on('connection_status', console.log);
    client.run('some_function', { testParam: 123 }, function(err, handlerResults) {
       // Check for errors, do something with results.
    });
    client.on('user_event', function(eventName, eventData) {
       // Do something with event data.
    });

__Note__: import/require/include the client library first, according to the previous section.


## Reference

The client library exposes a single class called `BaresoilClient`. It is recommended that you construct a single instance and re-use it for the duration of a client's immediate session.

    var client = new BaresoilClient(options);

### Construction and options

  * __`endpoint`__: the URL at which the Baresoil server is listening. Must be explicitly specified in node, and defaults to the path `/__bs__/live` of the server containing the page.
  * __`sessionRequest`__: arbitrary user-defined data to send to the server when a new connection is established. This parameter is passed to the server-side `session` handler function, if one is defined. _Defaults to undefined_.
  * __`connectPolicy`__: when the client should actually establish the connection to the server. Can be one of the following values:
    * `auto`: Connect to the server only when the first server-side handler function is called. _(default)_
    * `manual`: Connect only when the `connect()` method is manually called.
    * `immediate`: Connect immediately when the object is constructed.
  * __`verbose`__: writes lots of status information to `console.log`, useful for development. _Defaults to false_.

The __session request__ can contain any JSON-serializable data (i.e, no function objects), and is automatically sent to the server-side `session` handler as the
first command of every (re-)connection. Use the session request to
send information used by the server to set up a new client session, or re-establish an interrupted one.

The session request can be updated at any time, and accessed via the `sessionRequest` property on the client instance. It is intended to carry a small amount of authentication data, if required.

    client.setSessionRequest({
      socialSecurityNumber: '123-00-6789',
      bloodType: 'AB-'
    });

__Note__: the session request is instrumental in the design of apps that require authentication or user management. It is communicated to the server over the same secure channel as other function calls, and so is safe for carrying authentication data and secrets. It can assume the role of traditional HTTP cookies without the overhead of sending the cookie with each request.

### Connecting, disconnecting, and re-connecting

With the default __`connectPolicy`__ option value of "auto", the client will automatically connect to the server when it needs to. However, for the "manual" connection policy in particular, the `connect()` function must be called. It accepts to arguments, and should be treated as a trigger to _start_ the connection process. Calling `connect()` multiple times has no side-effects.

The client emits the `connect_status` event on various connection events. The first argument passed to the listener function is one of the following strings:

  * `offline`: just waiting around, doing nothing.
  * `connecting`: client just started connecting, stand by...
  * `setup`: client has established a connection and is sending the session request to the server-side handler function.
  * `connected`: session has been established and is now ready for use.
  * `reconnecting`: client has been disconnected, and is attempting to reconnect with a growing backoff delay.
  * `error`: the server terminated our connection. Reconnection should not be attempted until the error is resolved. No subsequent events will be emitted by the client.

For the `error` event, the second parameter supplied to the listener callback will be an object with the following fields.

  * `message`: A human-readable description of what the error condition is.
  * `code`: A numeric [CloseEvent](https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent) error code.
  * `retryAfter`: _(optional)_ If specified, then the epoch millisecond timestamp after which the client may try to re-connect. This is typically caused by an app that has temporarily exceeded its usage quota.

__Note__: To end the connection to the server, call `close()`. However, note that the advantage of a persistent connection is that setup and authorization do not have to performed on every request, so consider calling `close()` only when a user's immediate session has ended (e.g., if they navigate to another page).

### Server-side handlers and events

Once connected, you can call a server-side **handler** function using the
`run()` method on the client object. The example belows invokes a handler function called `bill_credit_card` using an object parameter containing some values, and then prints the result of server-side execution to the console.

    client.run('bill_credit_card', {amount: 'USD19.79'}, function(err, result) {
      if (err) {
        console.error('Could not bill card:', err);
      } else {
        console.log('Card billed.', result);
      }
    });

On the server, a file called `fn-bill_credit_card.js` is loaded in a sandbox,
executed, and its results automatically serialized, compressed, and returned to the client over a secure Websocket connection.

Once connected, server-side handlers can also send events to the client on
their own accord, i.e., without the client making a request. Examples of this include messaging programs, interactive games, and many situations where one user interacts with another in real time. The client can listen for these events using a simple node-style `EventEmitter` interface, consisting fundamentally of the `on()` and `removeListener()` methods.

    client.on('user_event', function(alertData) {
      console.log(alertData);
    });


## License

BaresoilClient is released under the Apache-2.0 License.
