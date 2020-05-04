# objectum-proxy
Reverse proxy for objectum platform https://github.com/objectum/objectum 

Objectum ecosystem:
* Javascript platform https://github.com/objectum/objectum  
* Isomorhic javascript client https://github.com/objectum/objectum-client  
* React components https://github.com/objectum/objectum-react  
* Command-line interface (CLI) https://github.com/objectum/objectum-cli  
* Objectum project example https://github.com/objectum/catalog 

## Install
```bash
npm install --save objectum-proxy
```

## API
* [Initialization](#init)  
* [Configuration](#configuration)  
* [Model server methods](#modelServerMethods)
* [Admin methods](#adminMethods)
* [Access methods](#accessMethods)

<a name="init" />

## Initialization
```js
import Proxy from "objectum-proxy";

import ItemModel from "./src/models/ItemModel.js";
import adminMethods from "./src/modules/admin.js";
import accessMethods from "./src/modules/access.js";

import fs from "fs";
import {fileURLToPath} from "url";
import {dirname} from "path";

const __filename = fileURLToPath (import.meta.url);
const __dirname = dirname (__filename);
const config = JSON.parse (fs.readFileSync ("./config.json", "utf8"));
const proxy = new Proxy ();

// Model server methods
proxy.register ("item", ItemModel);
// Admin methods
proxy.registerAdminMethods (adminMethods);
// Access methods
proxy.registerAccessMethods (accessMethods);

proxy.start ({config, path: "/api", __dirname});
```

<a name="configuration" />

## Configuration
config.js:
```js
{
    "code": "catalog",
    "rootDir": "/opt/objectum/projects/catalog",
    "adminPassword": "D033E22AE348AEB5660FC2140AEC35850C4DA997",
    "port": 3100,
    "database": {
        "host": "localhost",
        "port": 5432,
        "db": "catalog",
        "dbUser": "catalog",
        "dbPassword": "1",
        "dbaUser": "postgres",
        "dbaPassword": "12345"
    },
    "objectum": {
        "host": "localhost",
        "port": 8200
    }
}
```

<a name="modelServerMethods" />

## Model server methods
Methods are executed by current user session.  
ItemModel.js:
```js
import {Record, isServer} from "objectum-client";

class ItemModel extends Record {
    static async myStaticMethod ({store, myArg}) {
        if (!isServer ()) {
            return await store.remote ({
                model: "item",
                method: "myStaticMethod",
                myArg
            });
        }
        return arg1 * 2;
    }

    async myMethod ({myArg}) {
        if (!isServer ()) {
            return await store.remote ({
                model: "item",
                method: "myMethod",
                id: this.id,
                myArg
            });
        }
        const record = await this.store.getRecord (myArg);
 
        return this.myProperty + record.myAnotherProperty;
    }
};
```
App.js (client):
```js
import {Store} from "objectum-client";
import ItemModel from "./models/ItemModel";

const store = new Store ();

store.register ("item", ItemModel);
```

<a name="adminMethods" />

## Admin methods
Methods are executed by "admin" session.  
admin.js:
```js
async function register ({email, password, store}) {
    // ...
}
export default {
    register
};
```
Client:
```js
await store.remote ({
    model: "admin",
    method: "register",
    email, 
    password
});
```

<a name="accessMethods" />

## Access methods
Example for role "guest". access.js:
```js
let roleMap = {};
let map = {
    "guest": {
        "data": {
            "org": true
        },
        "read": {
            "objectum.role": true, "objectum.user": true, "org": true, "t.org.photo": true
        }
    }
};
// Module initialization
async function _init ({store}) {
    let roleRecs = await store.getRecs ({model: "objectum.role"});
    
    roleRecs.forEach (rec => roleMap [rec.id] = rec);
};
// Access to store.getData
function _accessData ({store, data}) {
    let role = roleMap [store.roleId].code;
    
    if (role == "guest") {
        return map.guest.data [data.model];
    }
    return true;
};
// Access to store.getData. Executed for all models in query
function _accessFilter ({store, model, alias}) {
    let role = roleMap [store.roleId].code;
    let userRecord = await store.getRecord (store.userId); 
    
    if (role == "myRole" && model.getPath () == "t.org.photo") {
        // Show only photos from user organization
        return [{[alias]: "org"}, "=", userRecord.org];
    }
    return;
};
// Access to store.createRecord
function _accessCreate ({store, model, data}) {
    let role = roleMap [store.roleId].code;
    
    if (role == "guest") {
        return false;
    }
    return true;
};
// Access to store.getRecord
function _accessRead ({store, model, record}) {
    let role = roleMap [store.roleId].code;
    let modelPath = model.getPath ();
    
    if (role == "guest") {
        return map.guest.read [modelPath];
    }
    return true;
};
// Access to store.updateRecord
function _accessUpdate ({store, model, record, data}) {
    let role = roleMap [store.roleId].code;
    
    if (role == "guest") {
        return false;
    }
    return true;
};
// Access to store.removeRecord
function _accessDelete ({store, model, record}) {
    let role = roleMap [store.roleId].code;
    
    if (role == "guest") {
        return false;
    }
    return true;
};

export default {
    _init,
    _accessData,
    _accessFilter,
    _accessCreate,
    _accessRead,
    _accessUpdate,
    _accessDelete
};
```
