![Ricochet.js](https://nodecraft.com/assets/ricochet/ricochet-logo.png)

Pub/Sub Framework for building robust TCP transport layers in node.js applications 

`npm install ricochet`

## Server
Serverside methods for the Pub-Sub network.

#### Initialization
```
var ricochet = require('@nodecraft/ricochet');
var server = new ricochet.Server({
    msgCat: '<<|#END#|>>',
    encryptionCat: '<||>',
    authTimeout: 3500,
    encrpytion: 'aes-256-xts'
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
    group: "optional"
}
```

###### `unroutedCallback = function(msg){ ... }`
This callback is triggered when a message fails to route. This callback is intended to be used to route the message in the event another client is connected to another server. This callback will not handle the routing, but merely prevent the `messageNotRouted` event from firing.

#### Events
- `message {id: '123-abc', msg: {...}}` - Fired when a message is successfully sent. Provides client id and message copy.
- `messageNotRouted {msg}` - Fired when a message could not be routed due to no client or group restrictions. Provides message copy.
- `invalidMessage {id: '123-abc', msg: {...}, Error: "what went wrong"}` - Fired when a message is malformed. Provides client id, message copy, and Error string of what is wrong.
- `clientAuthFail {id: '123-abc', Error: "what went wrong"}` - Fired when a client fails to authenticate. Provides client id and Error string of what is wrong.
- `clientAuthTimeout {id: '123-abc'}` - Fired when a client fails to authenticate in time. Provides client id.
- `clientReady {id: '123-abc'}` - Fired when a client successfully authenticated. Provides client id.
- `clientDisconnected {id: '123-abc'}` - Fired when a client successfully is disconnected. Provides client id.
- `clientError {id: '123-abc', Error: "what went wrong"}` - Fired when a client emits an error event from the raw socket. Provides client id and Error string of what is wrong.

## Client
Client to connect to the server.

#### Initialization
```
var ricochet = require('@nodecraft/ricochet');
var client = new ricochet.Server({
    msgCat: '<<|#END#|>>',
    encryptionCat: '<||>',
    timeout: 5000, // default timeout length for a message
    latencyBuffer: 1500, // default timeout length addition for local timeouts
    encrpytion: 'aes-256-xts'
});
client.connect({
    host: '127.0.0.1',
    port: 1337,
    localAddress: "127.0.0.2",
    publicKey: "abc-123",
    privateKey: "123-abc"
});
```

#### Methods

###### `connect(options, [callback])`
Connect to the server with provided details. LocalAddress is required to set what address the client will bind to when connecting to the remote server.

###### `message(channel, handle, message)`
Creates a single request which is blindly sent to the receipent. There is no guarantee this message was sent and no reply is expected.

###### `encrypt()`
Chainable message modifier to encrypt the Request.

###### `timeout(options, [callback])`
Chainable message modifier to adjust the Request's timeout length.

###### `request(channel, handle, message)`
Creates a Request as an event handler that sends the message and expects a reply, emitted back as an event below:
 - `timeout {local: true}` - The message timed out. If the timeout was emitted locally (the receiving party never got the message) it is returned in the local variable.
 - `update {data}` - An update to the request is posted. This prevents a timeout from occuring. This may trigger multiple times (to track the progress of the request).
 - `error {data}` - The results of the request resulted in an error
 - `fail {data}` - The results of the request resulted in an failure (not a hard error)
 - `success {data}` - The results of the request resulted in an success

###### `flushHandles(options, [callback])`
Clears all Handles, mainly used when closing a server.

###### `handle(options, [callback])`
Shortcut to using `client.handles.on(...)` to setup a Request Handle from another client. Callback is outlined below.

#### Request Handle
A request handle is fired from `server.handles` which allows you to bind to specific Request handles such as `files.list`. Each handler creates an Event handler which emits and expects the following events:

- `timeout {local: true}` - The request reached the timeout timer and the requesting client was notified. This is used to cleanup or handle the timeout gracefully. This event should not be emitted.
- `update {data}` - Emitted update to the request. This prevents a timeout from occuring. This may trigger multiple times (to track the progress of the request).
 - `error {data}` - Emitted results of the request resulting in an error
 - `fail {data}` - Emitted results of the request resulting in an failure (not a hard error)
 - `success {data}` - Emitted results of the request resulting in an success

 #### Events
- `ready {channel: '123-abc'}` - Fired when the client has successfully authenticated with the server and is ready to send/receive messages.
- `error {Error: "what went wrong"}` - Fired when a the server rejected the authentication.
- `socketError {error}` - Fired when a the socket connection has an error event emitted.
- `connected ` - Fired on the first connection to the server is established (not authenticated)
- `reconnected ` - Fired on when a new connection to the server is established (not authenticated)
- `disconnected ` - Fired on when a connection to the server is lost
