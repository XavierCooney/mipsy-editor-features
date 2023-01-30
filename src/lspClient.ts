import * as vscode from 'vscode';
import * as path from 'path';

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function startLSP(context: vscode.ExtensionContext) {
    console.log(context.asAbsolutePath(path.join('out', 'server.js')));

    let serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
    let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    let clientOptions: LanguageClientOptions = {
        documentSelector: [{
            language: 'mips'
        }]
    };

    console.log('config ' + JSON.stringify(vscode.workspace.getConfiguration('mips')));

    client = new LanguageClient(
        'MipsLangServ',
        'Mipsy language server (xav)',
        serverOptions,
        clientOptions
    );

    client.start();
}

export async function deactivateClient(): Promise<void> {
    if (client) {
        return await client.stop();
    }
}