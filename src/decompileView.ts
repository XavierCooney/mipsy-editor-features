import * as vscode from 'vscode';
import { decompile_source } from '../mipsy_vscode/pkg/mipsy_vscode';

export const DECOMPILE_SCHEME = 'mips-decompile';

export class DecompileView implements vscode.TextDocumentContentProvider {
    onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = this.onDidChangeEmitter.event;

    async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
        const originalUri = Buffer.from(
            uri.path.split('/', 1)[0], 'base64url'
        ).toString('utf8');

        let sourceDocument;
        try {
            sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(originalUri));
        } catch (err) {
            return `Couldn't open file! ${originalUri}`;
        }

        if (sourceDocument.languageId !== 'mips') {
            return `Cannot decompile non-mips file (language is ${sourceDocument.languageId})`;
        }

        const filename = uri.path.split('/', 2)[1]?.replace('Decompiled: ', '') || 'mips.s';

        // TODO: make this call on the language server side
        const decompiled = decompile_source(sourceDocument.getText(), filename);
        return `Decompilation of ${filename}:\n${decompiled}`.trimEnd() + '\n';
    }
}

export function setupDecompilationButton(context: vscode.ExtensionContext) {
    const decompileProver = new DecompileView();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
        DECOMPILE_SCHEME, decompileProver
    ));

    function filenameFromURI(uri: vscode.Uri) {
        // this is somewhat dodgy, but is only for display purposes so doesn't really matter
        const match = uri.path.match(/[^[\\/]*$/);
        return match ? match[0] : 'mips.s';
    }

    const filesToWatch = new Set();

    context.subscriptions.push(vscode.commands.registerCommand('mips.decompileCurrent', async (file?: vscode.Uri) => {
        if (!file) {
            file = vscode.window.activeTextEditor?.document.uri;
            if (!file) {
                return;
            }
        }

        if (file.scheme === DECOMPILE_SCHEME) {
            vscode.window.showErrorMessage('Cannot decompile a decompilation!');
            return;
        }

        const encodedUrl = Buffer.from(file.toString(), 'utf8').toString('base64url');

        const encodedUri = vscode.Uri.from({
            scheme: DECOMPILE_SCHEME, authority: '',
            path: `${encodedUrl}/Decompiled: ${filenameFromURI(file)}`
        });

        if (!filesToWatch.has(file.toString())) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(file, '*'
            ));
            context.subscriptions.push(watcher);
            watcher.onDidChange(() => {
                decompileProver.onDidChangeEmitter.fire(
                    encodedUri
                );
            });
            filesToWatch.add(file.toString());
        }

        const doc = await vscode.workspace.openTextDocument(encodedUri);
        await vscode.languages.setTextDocumentLanguage(doc, 'mips');
        await vscode.window.showTextDocument(doc, { preview: false });
    }));
}
