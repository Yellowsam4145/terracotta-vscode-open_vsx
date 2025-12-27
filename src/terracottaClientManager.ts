import { ClientRequest, IncomingMessage } from "node:http";
import { RawData, WebSocket } from "ws"

enum MessageType {
    Request = "request",
    Response = "response",
    Notification = "notification",
}

enum Permission {
    EditCode = "EDIT_CODE",
    ChangeMode = "CHANGE_MODE",
    GetPlotInfo = "GET_PLOT_INFO"
}

enum RequestMethod {
    RequestToken = "request_token"
}


class Message {
    public id: number = -1;

    constructor(
        public type: MessageType,
    ) {}

    protected buildOn(out: any) {
        out.id = this.id;
        out.type = this.type;
        out.data = {};
    }
    public serialize(): any {
        let out = {};
        this.buildOn(out);
        return JSON.stringify(out);
    }
}

class Request extends Message {
    constructor(
        public method: string,
    ) { super(MessageType.Request); }

    protected override buildOn(out: any) {
        super.buildOn(out);
        out.method = this.method;
    }
}

class Response extends Message {
    success: boolean = true;
    constructor() {
        super(MessageType.Response);
    }
}

class ErrorResponse extends Response {
    constructor(
        public errorCode: string,
        public errorMessage: string,
    ) {
        super()
        this.success = false;
    }
}

class RequestTokenA2CRequest extends Request {
    constructor(
        public appName: string,
        public permissions: Permission[],
    ) { super(RequestMethod.RequestToken); }

    protected override buildOn(out: any) {
        super.buildOn(out);
        out.data.app_name = this.appName;
        out.data.permissions = this.permissions;
    }
} 
class RequestTokenC2AResponse extends Response {
    constructor(
        public token: string,
    ) {super(); }
}

export let webSocket: WebSocket;

export let isConnected: boolean = false;
export let isAuthed: boolean = false;

let token: string;

/** key: id */
const activeRequests: Map<number, Request> = new Map();

function handleResponse(request: Request, response: Response) {
    if (request instanceof RequestTokenA2CRequest) {
        if (response instanceof ErrorResponse) {
            // disconnect or smth idk
        } else if (response instanceof RequestTokenC2AResponse) {
            token = response.token;
            isAuthed = true;
            console.log("RECEIVED A TOKEN!!",token)
        }
    }
}

let latestRequestId: number = 0;
export function sendRequest(request: Request) {
    latestRequestId++;
    request.id = latestRequestId;
    activeRequests.set(request.id,request);
    webSocket.send(request.serialize());
}

//TODO: periodic auto connection

export function tryConnection() {
    if (webSocket) webSocket.close();
    //client
    webSocket = new WebSocket("ws://localhost:39893");

    let interval = setInterval(() => {
        if (!webSocket) {
            clearInterval(interval);
            return;
        }
    }, 10000);
    
    webSocket.on("open",async () => {
        isConnected = true;

        console.log("OPENED!");
        sendRequest(new RequestTokenA2CRequest(
            "terracotta",
            [Permission.EditCode,Permission.ChangeMode,Permission.GetPlotInfo]
        ));
    })

    webSocket.on("message",(raw: RawData | string) => {
        console.log("received ",raw.toString());
        try {
            let msgJson = JSON.parse(raw.toString());
    
            let id: number = msgJson.id;
            let message: Message | undefined = undefined;
    
            messageParser: switch (msgJson.type) {
                case "response": {
                    let request = activeRequests.get(id);
                    if (!request) {throw new Error("Recieved response for an invalid request")}
                    if (msgJson.success == false) {
                        message = new ErrorResponse(msgJson.data.error_code, msgJson.data.error_message);
                    }
                    else if (request instanceof RequestTokenA2CRequest) {
                        message = new RequestTokenC2AResponse(msgJson.data.token);
                        break messageParser;
                    }
                }
            }
    
            if (message === undefined) { throw new Error("Failed to parse message (no idea why)"); }
            if (message instanceof Response) handleResponse(activeRequests.get(id)!, message);
        } catch (e) {
            console.error(e);
        }
    })

    webSocket.on("unexpected-response", (request: ClientRequest, response: IncomingMessage) => {
        console.error("unexpected response",request.toString(), response.toString());
    })
    
    webSocket.on("error",err => {
        console.error("error", err.name,err.stack);
    })

    webSocket.on("upgrade",() => {
        console.log("upgraded");
    })

    webSocket.on("close",() => {
        isConnected = false
        isAuthed = false
        console.log("CLOSED!")
    })
}