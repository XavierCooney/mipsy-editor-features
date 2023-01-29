import * as vscode from 'vscode';

export function setupDebugButton(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('mips.debug',  async (file?: vscode.Uri) => {
        file = file || vscode.window.activeTextEditor?.document.uri;
        if (!file) {
            return;
        }

        // for (let doc of vscode.workspace.textDocuments) {
        //     if (doc.uri.toString() === file.toString()) {
        //         doc.save();
        //     }
        // }

        vscode.debug.startDebugging(
            undefined, //vscode.workspace.workspaceFolders[0],
            {
                type: 'mipsy-1',
                name: 'mipsy run/debug',
                request: 'launch',
                program: file,
                programUri: file.toString(),
                console: 'integratedTerminal'
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

        vscode.window.showErrorMessage(`Debug session must be reloaded for ${change.document.fileName}!`);
    }));
}
