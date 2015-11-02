![Ricochet.js](https://nodecraft.com/assets/ricochet/ricochet-logo.png)

Pub/Sub Framework for building robust TCP transport layers in node.js applications

[![NPM](https://nodei.co/npm/ricochet.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/ricochet/)

`npm install ricochet`

## Server
Serverside methods for the Pub-Sub network.

#### Initialization
```
var ricochet = require('@nodecraft/ricochet');
var server = new ricochet.Server({
    delimiters: {
        message: "\"{MESSAGE}\"",
        encryption: "\"{ENCRYPT}\"",
        authKey: "$#AUTH#$"
    },
    encryption: "aes-256-xts"
});
server.listen(1337, '127.0.0.1');
```

#### Methods

###### `listen([port, address, callback])`
Begin accepting connections for the server.

###### `close([callback])`
Close all clients and stops accepting new connections.

#### Callback Hooks
###### `authCallback = function(data, callback){ ... }`
Required callback hook, used to verify authentication of a client to the server. The channel and group will dictate where messages are sent while the keys dictate authentication and encrpytion keys.
```
// data passed in
{
    publicKey: "abc-123",
    ip: "127.0.0.1",
    iphash: "F528764D624DB129B32C21FBCA0CB8D6"
}

// data expected on success
{
    channel: "api-server",
    publicKey: "abc-123",
    privateKey: "123-abc",
    groups: ["test"]
}
```

###### `unroutedCallback = function(msg){ ... }`
This callback is triggered when a message fails to route. This callback is intended to be used to route the message in the event another client is connected to a different server. This callback will not handle the routing, but merely prevent the `messageError` event from firing with this message.

#### Events
- `message {id: '123-abc', msg: {...}}` - Fired when a message is successfully sent. Provides client id and message copy.
- `messageError {msg}` - Fired when a message could not be routed or processed due to no client or group restrictions. Provides message copy.
- `invalidMessage {id: '123-abc', msg: {...}, Error: "what went wrong"}` - Fired when a message is malformed. Provides client id, message copy, and Error string of what is wrong.
- `clientInput {id: '123-abc', message: {...}}` - Fired when a client receives any message from the server. Useful for debug logging.
- `clientAuthFail {id: '123-abc', Error: "what went wrong", code:"error_code"}` - Fired when a client fails to authenticate. Provides client id, Error string and code of what went wrong.
- `clientReady {id: '123-abc'}` - Fired when a client successfully authenticated. Provides client id.
- `clientDisconnected {id: '123-abc'}` - Fired when a client successfully is disconnected. Provides client id.
- `clientConnected {id: '123-abc, ip: '123.123.123.123'}` - Fired when a client successfully connects to the server. Provides client ID and IP.
- `clientError {id: '123-abc', Error: "what went wrong"}` - Fired when a client emits an error event from the raw socket. Provides client id and Error string of what is wrong.
- `clientTimeout {id: '123-abc'}` - Fired when a client timeouts from the server.
- `error` - Event passed directly from `net.Server`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_server) for further details.
- `listening` - Event passed directly from `net.Server`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_server) for further details.

## Client
Client to connect to the server.

#### Initialization
```
var ricochet = require('ricochet');
var client = new ricochet.Client({
   "timeouts": {
        "reconnect": 1500,
        "message": 5000,
        "latencyBuffer": 1500, // default timeout length addition for local timeouts
        "auth": 3500,
        "authKey": 30000
    },
    delimiters: {
        message: "\"{MESSAGE}\"",
        encryption: "\"{ENCRYPT}\"",
        authKey: "$#AUTH#$"
    },
    encryption: "aes-256-xts"
});
client.connect({
    host: '127.0.0.1',
    port: 1337,
    localAddress: "127.0.0.2",
    publicKey: "abc-123",
    privateKey: "123-abc",
    authKey: "987-zyx"
});
```

#### Methods

###### `connect(options, [callback])`
Connect to the server with provided details. LocalAddress is required to set what address the client will bind to when connecting to the remote server.

###### `message(channel, handle, message)`
Creates a single request which is blindly sent to the receipent. There is no guarantee this message was sent, and no reply is expected.

###### `encrypt()`
Chainable message modifier to encrypt the request.

###### `timeout(options, [callback])`
Chainable message modifier to adjust the request's timeout length.

###### `request(channel, handle, message)`
Creates a Request as an event handler that sends the message and expects a reply, emitted back as an event below:
 - `timeout {local: true}` - The message timed out. If the timeout was emitted locally (the receiving party never got the message) it is returned in the local variable.
 - `update {data}` - An update to the request is posted. This prevents a timeout from occuring. This may trigger multiple times (to track the progress of the request).
 - `error {data}` - The results of the request resulted in an error
 - `fail {data}` - The results of the request resulted in an failure (not a hard error)
 - `success {data}` - The results of the request resulted in an success

###### `flushHandles(options, [callback])`
Clears all handles, mainly used when closing a server.

###### `handle(options, [callback])`
Shortcut to using `client.handles.on(...)` to setup a request handle from another client. Callback is outlined below.

#### Request Handle
A request handle is fired from `server.handles` which allows you to bind to specific Request handles such as `files.list`. Each handler creates an Event handler which emits and expects the following events:

- `timeout {local: true}` - The request reached the timeout timer and the requesting client was notified. This is used to cleanup or handle the timeout gracefully. This event should not be emitted.
- `update {data}` - Emitted update to the request. This prevents a timeout from occuring. This may trigger multiple times (to track the progress of the request, for example).
 - `error {data}` - Emitted results of the request resulting in an server error, with no response from the client, such as an unroutable host.
 - `response {err, data}` - Emitted results of the request resulting in a response. This could be a failure, or success, but this was dictated by the client's response.

 #### Events
- `ready {channel: '123-abc', groups: [...]}` - Fired when the client has successfully authenticated with the server and is ready to send/receive messages.
- `sendError {Error: "what went wrong", code: "error_code", message: {...}}` - Fired when a message fails to send. Includes original message, with Error string and code.
- `receiveError {Error: "what went wrong", code: "error_code", message: {...}}` - Fired when a message fails to be received (parsed). Includes original message, with Error string and code.
- `authFail {message: 'message'}` - Fired when the client fails to auth with the server. Includes original auth message.
- `connectionFail {err}` - Fired when the client fails to connect to the server.
- `connected` - Fired on the first connection to the server is established (not authenticated)
- `reconnected` - Fired on when a new connection to the server is established (not authenticated)
- `disconnected` - Fired on when a connection to the server is lost
- `error` - Event passed directly from `net.Socket`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_socket) for further details.
- `timeout` - Event passed directly from `net.Socket`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_socket) for further details. 
- `connect` - Event passed directly from `net.Socket`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_socket) for further details.
- `drain` - Event passed directly from `net.Socket`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_socket) for further details.
- `end` - Event passed directly from `net.Socket`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_socket) for further details.
- `lookup` - Event passed directly from `net.Socket`. See [Node.js documentation](https://nodejs.org/api/net.html#net_class_net_socket) for further details.
