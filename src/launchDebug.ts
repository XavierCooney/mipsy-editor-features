import * as vscode from 'vscode';

export function setupDebugButton(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('mips.debug',  async (file?: vscode.Uri) => {
        file = file || vscode.window.activeTextEditor?.document.uri;
        if (!file) {
            vscode.window.showErrorMessage(`No selected file to debug!`);
            return;
        }

        if (vscode.debug.activeDebugSession) {
            vscode.window.showErrorMessage(`There's already an active debug session!`);
            return;
        }

        let doCustomSourceSending = {};
        if (file.scheme !== 'file') {
            doCustomSourceSending = {
                uri: file.toString()
            };
        }

        vscode.debug.startDebugging(
            undefined, //vscode.workspace.workspaceFolders[0],
            {
                type: 'mipsy-1',
                name: 'mipsy run/debug',
                request: 'launch',
                program: file,
                programUri: file.toString(),
                console: 'integratedTerminal',
                doCustomSourceSending
            },
            undefined
        );
    }));

    const uriToSessionIds: {[uri: string]: Set<string>} = Object.create(null);

    context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.type !== 'mipsy-1') {
            return;
        }

        const uri = session.configuration.programUri;
        if (!uriToSessionIds[uri]) {
            uriToSessionIds[uri] = new Set();
        }

        uriToSessionIds[uri].add(session.id);
    }));

    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
        if (e.session.type !== 'mipsy-1') {
            return;
        }

        if (e.event !== 'mipsySource') {
            return;
        }

        const uri = vscode.Uri.parse(e.body.uri);

        vscode.workspace.openTextDocument(uri).then(document => {
            let text = document.getText();
            e.session.customRequest('mipsySource', {
                source: text
            });
        });
    }));

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
        if (session.configuration.type !== 'mipsy-1') {
            return;
        }

        const uri = session.configuration.programUri;
        uriToSessionIds[uri]?.delete(session.id);
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(change => {
        const uri = change.document.uri;

        const set = uriToSessionIds[uri.toString()];
        if (!set || set.size === 0) {
            return;
        }

        set.clear();

        vscode.window.showErrorMessage(`Debug session must be reloaded before changes take effect!`);
    }));
}

export function setupSendInputButton(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerTextEditorCommand('mipsy.debug.sendSelectionToInput', (editor, edit) => {
        let text = editor.document.getText(editor.selection);
        vscode.debug.activeDebugSession?.customRequest('queueInput', {
            contents: text
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('mipsy.debug.sendFileToInput', (uri: vscode.Uri) => {
        vscode.workspace.openTextDocument(uri).then(document => {
            let text = document.getText();
            vscode.debug.activeDebugSession?.customRequest('queueInput', {
                contents: text
            });
        });
    }));
}
