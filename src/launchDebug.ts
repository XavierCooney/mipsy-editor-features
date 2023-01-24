import * as vscode from 'vscode';

export function setupDebugButton(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('mips.debug',  async (file?: vscode.Uri) => {
        if (!file) {
            file = vscode.window.activeTextEditor?.document.uri;
            if (!file) {
                return;
            }
        }

        vscode.window.showInformationMessage('URL ' + file.toString());

        vscode.debug.startDebugging(
            undefined, //vscode.workspace.workspaceFolders[0],
            {
                type: 'mipsy-1',
                name: 'session name',
                request: 'launch',
                program: file,
                console: 'integratedTerminal'
            },
            undefined
        );
    }));

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(console.log));
    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(console.log));
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(console.log));
}
