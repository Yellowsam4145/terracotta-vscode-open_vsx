import { ClientRequest, IncomingMessage } from "node:http";
import { ExtensionContext, window } from "vscode";
import { RawData, WebSocket } from "ws"
import { isPortTaken } from "./util/util";

enum MessageType {
    REQUEST = "REQUEST",
    RESPONSE = "RESPONSE",
    NOTIFICATION = "NOTIFICATION",
}

enum Permission {
    EDIT_CODE = "EDIT_CODE",
    CHANGE_MODE = "CHANGE_MODE",
    GET_PLOT_INFO = "GET_PLOT_INFO"
}

enum RequestMethod {
    REQUEST_TOKEN = "REQUEST_TOKEN",
    PROVIDE_TOKEN = "PROVIDE_TOKEN",
    INITIATE_CODE_EDIT = "INITIATE_CODE_EDIT",
}

enum NotificationMethod {
    MODE_CHANGED = "MODE_CHANGED",
}

export enum DFMode {
    SPAWN = "SPAWN",
    DEV = "DEV",
    PLAY = "PLAY",
    BUILD = "BUILD",
}

export enum TemplateType {
    PLAYER_EVENT = "PLAYER_EVENT",
    ENTITY_EVENT = "ENTITY_EVENT",
    FUNCTION = "FUNCTION",
    PROCESS = "PROCESS",
}

export interface TemplateIdentifier {
    type: TemplateType,
    name: string
}


export class Message {
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

type RequestCallback<T extends Request, Y extends Response> = (request: T, response: Y) => void;
export class Request extends Message {
    readonly RESPONSE_CLASS: (new (...args: any[]) => Response) & {
        parse: (msgJson: any) => Response
    } = Response;

    responseCallbacks: RequestCallback<any,any>[] = [];

    constructor(
        public method: string,
    ) { super(MessageType.REQUEST); }

    protected override buildOn(out: any) {
        super.buildOn(out);
        out.method = this.method;
    }
}

export class Response extends Message {
    success: boolean = true;
    constructor() {
        super(MessageType.RESPONSE);
    }

    static parse(msgJson: any) {
        return new Response();
    }
}

export class Notification extends Message {
    constructor() {
        super(MessageType.NOTIFICATION);
    }

    static parse(msgJson: any): Notification {
        return new Notification()
    }
}

export class ErrorResponse extends Response {
    constructor(
        public errorCode: string,
        public errorMessage: string,
    ) {
        super()
        this.success = false;
    }
}

//=- request token -=\\
export class RequestTokenA2CRequest extends Request {
    override readonly RESPONSE_CLASS = RequestTokenC2AResponse;

    constructor(
        public appName: string,
        public permissions: Permission[],
    ) { super(RequestMethod.REQUEST_TOKEN); }

    protected override buildOn(out: any) {
        super.buildOn(out);
        out.data.app_name = this.appName;
        out.data.permissions = this.permissions;
    }
} 
export class RequestTokenC2AResponse extends Response {
    constructor(
        public token: string,
    ) {super(); }

    static override parse(msgJson: any): RequestTokenC2AResponse {
        return new RequestTokenC2AResponse(msgJson.data.token);
    }
}

//=- provide token -=\\
export class ProvideTokenA2CRequest extends Request {
    override readonly RESPONSE_CLASS = ProvideTokenC2AResponse;

    constructor(
        public token: string,
    ) { super(RequestMethod.PROVIDE_TOKEN); }

    protected override buildOn(out: any) {
        super.buildOn(out);
        out.data.token = this.token;
    }
} 
export class ProvideTokenC2AResponse extends Response {
    constructor() {super(); }

    static override parse(msgJson: any): ProvideTokenC2AResponse {
        return new ProvideTokenC2AResponse();
    }
}

//=- initiate code edit -=\\
export class InitiateCodeEditA2CRequest extends Request {
    override readonly RESPONSE_CLASS = InitiateCodeEditC2AResponse;

    constructor(
        public placeTemplates: string[],
        public breakTemplates: TemplateIdentifier[],
    ) { super(RequestMethod.INITIATE_CODE_EDIT); }

    protected override buildOn(out: any) {
        super.buildOn(out);
        out.data.place_templates = this.placeTemplates;
        out.data.break_templates = this.breakTemplates;
    }
}
export class InitiateCodeEditC2AResponse extends Response {
    constructor() { super(); }

    static override parse(msgJson: any): InitiateCodeEditC2AResponse {
        return new InitiateCodeEditC2AResponse();
    }
}

//=- notifications -=\\
export class ModeChangedC2ANotification extends Notification {
    constructor(
        public newMode: DFMode
    ) { super(); }
    
    static override parse(msgJson: any): ModeChangedC2ANotification {
        return new ModeChangedC2ANotification(msgJson.data.new_mode);
    }
}

export let webSocket: WebSocket;

export let isConnected: boolean = false;
export let isAuthed: boolean = false;

export let mode: DFMode = DFMode.SPAWN;

let extensionContext: ExtensionContext;
let token: string | undefined = undefined;
let providedToken: string | undefined = undefined;

/** key: id */
const activeRequests: Map<number, Request> = new Map();

async function handleResponse(request: Request, response: Response) {
    for (const callback of request.responseCallbacks) {
        callback(request, response);
    }
}

async function handleNotification(notification: Notification) {
    if (notification instanceof ModeChangedC2ANotification) {
        mode = notification.newMode;
    }
}

function requestToken() {
    sendRequest(
        new RequestTokenA2CRequest(
            "terracotta",
            [Permission.EDIT_CODE,Permission.CHANGE_MODE,Permission.GET_PLOT_INFO]
        ), 
        async (request, response: RequestTokenC2AResponse) => {
            if (response instanceof ErrorResponse) {
                // TODO: prompt to refresh connection
                window.showErrorMessage(`Could not connect to Terracotta client: ${response.errorMessage}`);
                close();
            } else if (response instanceof RequestTokenC2AResponse) {
                token = response.token;
                isAuthed = true;
                await extensionContext.secrets.store('tcclient_token', token);
            }
        }
    );
}

let latestRequestId: number = 0;
export function sendRequest<T extends Request, Y extends Response>(request: T, callback?: (request: T, response: Y) => void) {
    latestRequestId++;
    request.id = latestRequestId;
    activeRequests.set(request.id,request);
    if (callback) request.responseCallbacks.push(callback);
    webSocket.send(request.serialize());
}

export function initialize(context: ExtensionContext) {
    extensionContext = context;
}

export async function tryConnection() {
    if (webSocket) webSocket.close();
    let isTaken = await isPortTaken(39893);
    if (isTaken == false) return;
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

        console.log ("OPENED!");
        let storedToken = await extensionContext.secrets.get("tcclient_token");
        if (storedToken) {
            providedToken = storedToken;
            sendRequest(
                new ProvideTokenA2CRequest(storedToken),
                (request, response: ProvideTokenC2AResponse) => {
                    if (response instanceof ErrorResponse) {
                        console.warn(`Provided token was invalid, requesting new one (${response.errorMessage})`)
                        requestToken();
                    } else if (response instanceof ProvideTokenC2AResponse) {
                        isAuthed = true;
                        token = providedToken;
                    }
                }
            )
        } else {
            requestToken();
        }
    })

    webSocket.on("message",(raw: RawData | string) => {
        console.log ("received ",raw.toString());
        try {
            let msgJson = JSON.parse(raw.toString());
    
            let id: number = msgJson.id;
            let message: Message | undefined = undefined;
    
            messageParser: switch (msgJson.type) {
                case MessageType.RESPONSE: {
                    let request = activeRequests.get(id);
                    if (!request) {throw new Error("Recieved response for an invalid request")}
                    if (msgJson.success) {
                        message = request.RESPONSE_CLASS.parse(msgJson);
                    } else {
                        message = new ErrorResponse(msgJson.data.error_code, msgJson.data.error_message);
                    }


                    break messageParser;
                }
                case MessageType.NOTIFICATION: {
                    let notificationClass;
                    switch (msgJson.method) {
                        case NotificationMethod.MODE_CHANGED: { notificationClass = ModeChangedC2ANotification; break }
                        default: throw new Error(`Received notification for unknown method ${msgJson.method}`)
                    }
                    message = notificationClass?.parse(msgJson);
                    
                    break messageParser;
                }
            }
    
            if (message === undefined) { throw new Error("Failed to parse message (no idea why)"); }
            if (message instanceof Response) handleResponse(activeRequests.get(id)!, message);
            if (message instanceof Notification) handleNotification(message);
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
        // console.log("upgraded");
    })

    webSocket.on("close",() => {
        if (isConnected) {
            console.log ("CLOSED!")
        }
        isConnected = false
        isAuthed = false
    })
}

export function close() {
    webSocket.close();
}

setInterval(() => {
    if (!isConnected) tryConnection()
},10000)