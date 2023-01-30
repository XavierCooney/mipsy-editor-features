import { debug } from 'console';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';


export function setupIOView(context: vscode.ExtensionContext) {
    const allOutputs: {[id: string]: number[]} = {};
    let allWebviews: vscode.Webview[] = [];

    context.subscriptions.push(vscode.window.registerWebviewViewProvider(
        'mips.xavc.io',
        new IOViewProvider(context, addNewWebView)
    ));

    context.subscriptions.push(vscode.debug.onDidStartDebugSession(e => {
        allOutputs[e.id] = [];
    }));

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(e => {
        delete allOutputs[e.id];
    }));

    function addNewWebView(webviewView: vscode.WebviewView) {
        allWebviews.push(webviewView.webview);

        context.subscriptions.push(webviewView.onDidDispose(() => {
            allWebviews = allWebviews.filter(webview => webview !== webviewView.webview);
        }));

        webviewView.webview.onDidReceiveMessage(message => {
            if (message.command === 'req_full') {
                sendFullUpdate(webviewView.webview);
            }
        });
    }

    function sendFullUpdate(webview: vscode.Webview) {
        const initialBody: number[] = [];

        const message = {
            command: 'full',
            body: initialBody
        };

        if (vscode.debug.activeDebugSession) {
            message.body = allOutputs[vscode.debug.activeDebugSession.id] || [];
        }

        webview.postMessage(message);
    }

    context.subscriptions.push(vscode.debug.onDidChangeActiveDebugSession(e => {
        allWebviews.forEach(webview => {
            sendFullUpdate(webview);
        });
    }));

    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
        if (e.session.type !== 'mipsy-1') {
            return;
        }

        if (e.event !== 'mipsyOutput') {
            return;
        }

        allOutputs[e.session.id].push(...e.body.charCodes);

        if (e.session.id === vscode.debug.activeDebugSession?.id) { 
            allWebviews.forEach(webview => {
                webview.postMessage({
                    command: 'incremental',
                    body: e.body.charCodes
                });
            });
        }
    }));
}

class IOViewProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly addNewWebviewView: (webviewView: vscode.WebviewView) => void
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): void | Thenable<void> {
        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.html = fs.readFileSync(
            this.extensionContext.asAbsolutePath(path.join('src', 'ioView.html')),
            { encoding: 'utf-8' }
        );

        this.addNewWebviewView(webviewView);
    }
}