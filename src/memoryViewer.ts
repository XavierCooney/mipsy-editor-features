import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function setupMemoryButton(context: vscode.ExtensionContext) {
    const allPanels: {[id: string]: vscode.WebviewPanel} = {};
    const memoryValues: {[id: string]: number[]} = {};
    const selectedBytesPerRow: {[id: string]: number[]} = {};

    function sendPanelData(id: string) {
        allPanels[id]?.webview.postMessage({
            type: 'more mem!',
            data: memoryValues[id],
            selectedBytesPerRow: selectedBytesPerRow[id] || -1
        });
    }

    context.subscriptions.push(vscode.commands.registerCommand('mips.debug.viewMemory', () => {
        const session = vscode.debug.activeDebugSession;

        if (!session) {
            vscode.window.showErrorMessage('no active debug session?!');
            return;
        }

        if (session.type !== 'mipsy-1') {
            vscode.window.showErrorMessage('not mipsy');
            return;
        }

        const debugId = session.id;

        const panel = vscode.window.createWebviewPanel(
            'mipsy-memory',
            'Mipsy Memory',
            vscode.ViewColumn.Beside, {
                enableScripts: true
            }
        );
        context.subscriptions.push(panel);

        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'memoryWebviewBundle.js'));

        panel.webview.html = fs.readFileSync(
            context.asAbsolutePath(path.join('src', 'memoryPanel.html')),
            { encoding: 'utf-8' }
        ).replace('{{{BUNDLE_URI}}}', scriptUri.toString());
        console.log('debug id ' + debugId);

        allPanels[debugId] = panel;

        context.subscriptions.push(panel.webview.onDidReceiveMessage(mesage => {
            if (mesage.selectedBytesPerRow !== null) {
                selectedBytesPerRow[debugId] = mesage.selectedBytesPerRow;
            }

            sendPanelData(debugId);
        }));
    }));

    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
        if (e.session.type !== 'mipsy-1') {
            return;
        }

        if (e.event !== 'mipsyMemory') {
            return;
        }

        memoryValues[e.session.id] = e.body.memory;
        sendPanelData(e.session.id);
    }));

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(e => {
        allPanels[e.id]?.dispose();
        delete allPanels[e.id];
        delete memoryValues[e.id];
    }));
}