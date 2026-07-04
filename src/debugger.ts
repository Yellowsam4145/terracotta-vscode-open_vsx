/*

The actual compilation logic is handled by the main extension;
this is basically just a wrapper of the debug console that exists since
vscode doesn't provide a native way for extensions to interface with it
other than going through a "debugger" like this

*/

import { DebugProtocol as dap } from "vscode-debugprotocol"

//==========[ util functions ]=========\

function sendEvent(event: string, body: any = null) {
    let str = JSON.stringify({
        type: "event",
        event: event,
        body: body
    })
    
    process.stdout.write(`Content-Length: ${Buffer.from(str,"utf-8").length}\r\n\r\n${str}`)
}

function sendResponse(request: dap.Request, body: any, successful: boolean = true) {
    let str = JSON.stringify({
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: successful,
        body: body
    })
    
    process.stdout.write(`Content-Length: ${str.length}\r\n\r\n${str}`)
}

const requestHandlers: {[key: string]: (args: dap.Request) => void} = {
    "initialize": function(request) {
        sendResponse(request,{
            supportsConfigurationDoneRequest: true
        })
    },
    "launch": async function(request) {
        sendResponse(request,{})
        sendEvent("sendLaunchArgs",request.arguments);
    },
    "disconnect": function (request) {
        sendEvent('output',{
            output: "Compilation was canceled from within the IDE\n",
            category: "stderr",
        });
        sendResponse(request,{});
    },
    "terminate": function (request) {
        sendEvent('output',{
            output: "Compilation was canceled from within the IDE\n",
            category: "stderr",
        });
        sendResponse(request,{});
    },
    "log": function(request) {
        sendEvent('output',{
            output: request.arguments+"\n",
            category: "console",
        })
        sendResponse(request,{});
    },
    "bluelog": function(request) {
        sendEvent('output',{
            output: request.arguments+"\n",
            category: "stdout",
        })
        sendResponse(request,{});
    },
    "error": function(request) {
        sendEvent('output',{
            output: request.arguments+"\n",
            category: "stderr",
        })
        sendResponse(request,{});
    },
    "end": function(request) {
        setTimeout(() => process.exit(request.arguments), 100);
        sendResponse(request,{});
    }
}

process.stdin.on("data",data => {
    let commands = data.toString().split(/Content-Length: \d+\r\n\r\n/g)
    commands.shift() //since the first entry will always be an empty string

    for (let command of commands) {
        let json = JSON.parse(command)
        if (json.type == "request") {
            if (requestHandlers[json.command]) {
                requestHandlers[json.command](json)
            }   
        }
    }
})