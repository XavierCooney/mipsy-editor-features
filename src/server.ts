import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    Location,
    SymbolKind,
    DocumentSymbol,
    SymbolInformation
} from 'vscode-languageserver/node';

import { test_compile } from '../mipsy_vscode/pkg/mipsy_vscode';

import {
    Position,
    TextDocument,
} from 'vscode-languageserver-textdocument';

import { suggestions as staticSuggestions }  from './lsp_data.json';

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';


const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const splitSources: {[uri: string]: string[]} = {};

interface Definition {
    type: 'label' | 'constant',
    line: number,
    identifier: string,
    sourceUri: string,
}

const cachedDefinitions: {[uri: string]: Definition[] | undefined} = {};


let hasConfigurationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!capabilities?.workspace?.configuration;
    // console.log(capabilities.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport);
    // capabilities.textDocument?.completion?.completionItem.

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                triggerCharacters: ['$', '.'],
                completionItem: {
                    labelDetailsSupport: true
                },
                // resolveProvider: true
            },
            definitionProvider: {},
            documentSymbolProvider: true
        }
    };

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
});

interface MipsSettings {
    maxDiagonstics: number;
}

const defaultSettings: MipsSettings = {
    maxDiagonstics: 3
};
const documentSettings: Map<string, Thenable<MipsSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
    }

    documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<MipsSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(defaultSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'mips'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

let multiFileDependencies: {[uri: string]: string[]} = {};

function getFilenameFromUri(uri: string) {
    const components = uri.split('/');
    return components[components.length - 1];
}

function setFilenameOfUri(uri: string, newName: string) {
    const components = uri.split('/');
    components.splice(components.length - 1);
    components.push(newName);
    return components.join('/');
}

const MULTIFILE_REGEX = /#[^\n@]*@[ \t]*\[[ \t]*multifile[ \t]*\(([^)\n]*)\)[ \t]*\]/g;

function getMultifileSources(uri: string): string | { filename: string, source: string, uri: string }[] {
    const rootDocument = documents.get(uri);
    if (!rootDocument) {
        return `root document not found ${uri}`;
    }
    const rootSource = rootDocument.getText();

    const result = [{
        filename: getFilenameFromUri(uri),
        source: rootSource,
        uri
    }];

    const allExtraFiles = Array.from(rootSource.matchAll(MULTIFILE_REGEX)).map(match => {
        return match[1].split(',').map(s => s.trim()).filter(s => s !== '');
    }).flat(1);

    const unavailableFiles: string[] = [];
    const allUris: string[] = [];

    allExtraFiles.forEach(extraFile => {
        const newUri = setFilenameOfUri(uri, extraFile);

        if (result.find(m => m.uri === newUri) !== undefined) {
            return;
        }

        const subDocument = documents.get(newUri);

        if (subDocument !== undefined) {
            result.push({
                filename: extraFile,
                source: subDocument.getText(),
                uri: newUri
            });
        } else {
            try {
                const path = fileURLToPath(newUri);
                const source = readFileSync(path, { encoding: 'utf-8' });

                result.push({
                    filename: extraFile,
                    source,
                    uri: newUri
                });
            } catch {
                unavailableFiles.push(extraFile);
            }
        }

        allUris.push(newUri);
    });

    multiFileDependencies[uri] = allUris;

    if (unavailableFiles.length) {
        const plural = unavailableFiles.length !== 1 ? 's' : '';
        const delmitedFiles = unavailableFiles.map(file => '`' + file + '`').join(', ');
        return `please open the file${plural} ${delmitedFiles} to get editor features support for this multi-file program.`;
    }

    return result.filter(file => file.uri !== uri);
}

function getLineWithMultifileDeclaration(uri: string): number {
    // just for diagonstics purposes, there could be multiple multifile things
    const lines = splitSources[uri] || '';
    return lines.map((line, index) => {
        if (MULTIFILE_REGEX.test(line)) {
            return index;
        } else {
            return undefined;
        }
    }).filter(index => index !== undefined)[0] || 0;
}

documents.onDidClose(e => {
    delete splitSources[e.document.uri];
    delete cachedDefinitions[e.document.uri];
    delete multiFileDependencies[e.document.uri];

    connection.sendDiagnostics({
        uri: e.document.uri,
        diagnostics: []
    });

    documentSettings.delete(e.document.uri);
});

function splitSourceIntoLines(source: string) {
    let splitter = source.indexOf('\r\n') === -1 ? '\n' : '\r\n';
    return source.split(splitter).map(line => line.replaceAll('\r', '').replaceAll('\n', ''));
}

documents.onDidChangeContent(change => {
    const source = change.document.getText();
    delete cachedDefinitions[change.document.uri];
    splitSources[change.document.uri] = splitSourceIntoLines(source);

    validateTextDocument(change.document);

    Object.keys(multiFileDependencies).forEach(key => {
        if (multiFileDependencies[key].includes(change.document.uri)) {
            const document = documents.get(key);
            if (document) {
                validateTextDocument(document);
            }
        }
    });
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    if (textDocument.uri.startsWith('mips-decompile:')) {
        connection.sendDiagnostics({
            uri: textDocument.uri, diagnostics: []
        });
        return;
    }

    connection.console.log(`validating ${textDocument.uri}...`);

    const multiFiles = getMultifileSources(textDocument.uri);

    if (typeof multiFiles === 'string') {
        const multfileLine = getLineWithMultifileDeclaration(textDocument.uri);

        connection.sendDiagnostics({
            uri: textDocument.uri, diagnostics: [{
                message: `error with multi-file support: ${multiFiles}`,
                range: {
                    start: { line: multfileLine, character: 0 },
                    end: { line: multfileLine, character: Number.MAX_SAFE_INTEGER },
                },
                severity: DiagnosticSeverity.Error,
                source: 'mipsy'
            }]
        });

        return;
    }

    const settings = await getDocumentSettings(textDocument.uri);
    const recheckAmt = settings?.maxDiagonstics || 3;

    const source = textDocument.getText();

    const diagnostics: Diagnostic[] = [];

    const response = test_compile(source, getFilenameFromUri(textDocument.uri), multiFiles, recheckAmt);

    let tabsSize = 8;
    const tabSizeAttributeMatch = /#!\[[ \t]*tabsize[ \t]*\([ \t]*(\d{1,2})[ \t]*\)[ \t]*\]/.exec(source);
    if (tabSizeAttributeMatch && tabSizeAttributeMatch[1]) {
        tabsSize = parseInt(tabSizeAttributeMatch[1]) || tabsSize;
    }

    function correctColumn(lineNum: number, column: number) {
        if (column === 0) {
            return column;
        }

        try {
            const lineStartOffset = textDocument.offsetAt({
                line: lineNum,
                character: 0
            });
            const lineRegExp = /(.*)$/gm;
            lineRegExp.lastIndex = lineStartOffset;
            const lineMatch = lineRegExp.exec(source);
            if (!lineMatch || !lineMatch.length) {
                return column;
            }

            const lineContents = lineMatch[1];

            let actualColumn = 0;
            let displayColumn = 0;
            for (let c of lineContents) {
                displayColumn += c === '\t' ? tabsSize : 1;
                actualColumn++;

                if (displayColumn === column) {
                    return actualColumn;
                }
            }

            return column;
        } catch {
            return column;
        }

    }

    for (let err of response.errors) {
        // just stick non localised errors at the start
        let lineNum = err.localised ? err.line - 1 : 0;

        if (!err.localised && err.is_multfile_related) {
            lineNum = getLineWithMultifileDeclaration(textDocument.uri);
        }

        let message = err.message;
        if (err.tips && err.tips.length) {
            if (err.tips.length === 1) {
                message += `\nTip from mipsy: ${err.tips[0]}`.trimEnd();
            } else {
                message += `\nTips from mipsy:\n${
                    err.tips.map((tip: string) => '* ' + tip + '\n')
                }`.trimEnd();
            }
        }

        if (!err.localised) {
            message += '\n[this error applies to the whole file]';
        }

        const diagnostic: Diagnostic = {
            severity: err.is_warning ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
            range: {
                start: {
                    line: lineNum,
                    character: err.localised ? correctColumn(lineNum, err.col - 1) : 0,
                },
                end: {
                    line: lineNum,
                    character: err.localised ? correctColumn(lineNum, err.col_end - 1) : Number.MAX_VALUE,
                },
            },
            message: message.trim(),
            source: 'mipsy'
        };

        // console.log(diagnostic);
        diagnostics.push(diagnostic);
    };

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
    connection.console.log('Received a file change event');
});

function getDefinitions(uri: string): Definition[] {
    const cachedValue = cachedDefinitions[uri];
    if (cachedValue) {
        return cachedValue;
    }

    const lines = splitSources[uri] || [];
    const definitions: Definition[] = [];

    const allSources = [{
        uri: uri, lines
    }];

    const multiFile = getMultifileSources(uri);
    if (typeof multiFile !== 'string') {
        allSources.push(...multiFile.map(file => ({
            uri: file.uri,
            lines: splitSourceIntoLines(file.source)
        })));
    }

    allSources.forEach(({uri, lines}) => {
        lines.forEach((line, lineNum) => {
            const trimmed = line.split('#')[0].trim();
            if (trimmed === '') {
                return;
            }

            let lineIter = line;

            while (true) {
                const match = /^[ \t]*([a-zA-Z_0-9.]+)[ \t]*:(.*)$/.exec(lineIter);
                if (match === null) {
                    break;
                }
                definitions.push({
                    identifier: match[1],
                    line: lineNum,
                    type: 'label',
                    sourceUri: uri
                });
                lineIter = match[2];
            }

            while (true) {
                const match = /^[ \t]*([a-zA-Z_0-9.]+)[ \t]*=(.*)$/.exec(lineIter);
                if (match === null) {
                    break;
                }
                definitions.push({
                    identifier: match[1],
                    line: lineNum,
                    type: 'constant',
                    sourceUri: uri
                });
                lineIter = match[2];
            }

        });
    });

    return (cachedDefinitions[uri] = definitions);
}

connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    const lineNum = textDocumentPosition.position.line;
    const colNum = textDocumentPosition.position.character;
    const uri = textDocumentPosition.textDocument.uri;
    const line = (splitSources[uri] || [])[lineNum] || '';
    const definitions = getDefinitions(uri);

    const before = line.slice(0, colNum);
    const after = line.slice(colNum);

    if (before.indexOf('#') !== -1) {
        // probably in comment - although the # might be in a string/character literal
        return [];
    }

    const beforeWord = (/\$?[a-zA-Z.0-9]*$/.exec(before) || [''])[0] || '';
    const beforeWithLabelsRemoved = before.replace(/[A-Za-z_][A-Za-z_0-9.]*[ \t]*:/g, '');

    const isStartOfLine = /^[ \t]*$/.test(
        beforeWithLabelsRemoved.slice(0, beforeWithLabelsRemoved.length - beforeWord.length)
    );
    const isImmeadiateV0 = /^[ \t]*li[ \t]+\$v0[ \t]*,[ \t]*[0-9]{0,2}$/.test(beforeWithLabelsRemoved);

    const allSuggestions = Array.from(staticSuggestions);

    // console.log({before,after,beforeWord,beforeWithLabelsRemoved,isStartOfLine});

    definitions.forEach(definition => {
        allSuggestions.push({
            label: definition.identifier,
            type: definition.type,
        });
    });

    const result: CompletionItem[] = [];

    allSuggestions.forEach(suggestion => {
        if (!isStartOfLine && suggestion.type === 'instruction') {
            return;
        }

        if (!isStartOfLine && suggestion.type === 'directive') {
            return;
        }

        if (suggestion.type === 'syscall_num' && !isImmeadiateV0) {
            return;
        }

        let sortLevel = 'c';

        if (suggestion.type === 'register') {
            sortLevel = 'd';
        }

        if (suggestion.type === 'register' && beforeWord.startsWith('$') && !isStartOfLine) {
            sortLevel = 'a';
        }

        if (suggestion.type === 'directive' && beforeWord.startsWith('.') && isStartOfLine) {
            sortLevel = 'a';
        }

        if (suggestion.type === 'directive' && !isStartOfLine) {
            sortLevel = 'e';
        }

        if (suggestion.type === 'syscall_num') {
            sortLevel = `a${suggestion.syscall_common ? 'a' : 'b'}$`;
        }

        const item: CompletionItem = {
            label: suggestion.label,
            kind: CompletionItemKind.Function,
            filterText: suggestion.label,
            sortText: `${sortLevel}${suggestion.sort_data || ''}${suggestion.label}`,
            data: {}
        };

        if (suggestion.type === 'instruction') {
            item.kind = CompletionItemKind.Function;
        } else if (suggestion.type === 'constant') {
            item.kind = CompletionItemKind.Constant;
        } else if (suggestion.type === 'label') {
            item.kind = CompletionItemKind.Reference;
        } else if (suggestion.type === 'directive') {
            item.kind = CompletionItemKind.Keyword;
        } else if (suggestion.type === 'register') {
            item.kind = CompletionItemKind.Variable;
        } else if (suggestion.type === 'syscall_num') {
            item.kind = CompletionItemKind.Event;
        } else {
            console.log(`Don't know what kind for ${suggestion.type}`);
        }

        if (suggestion.docs && suggestion.docs !== 'todo') {
            item.labelDetails = {
                description: suggestion.docs
            };
            if (suggestion.type === 'syscall_num') {
                item.documentation = `syscall: ${suggestion.docs}`;
            } else {
                item.documentation = suggestion.docs;
            }
        }

        let matchingLength = 0;
        while (matchingLength < Math.min(beforeWord.length, suggestion.label.length)) {
            if (beforeWord[matchingLength] === suggestion.label[matchingLength]) {
                matchingLength++;
            } else {
                break;
            }
        }

        const appendTab = isStartOfLine && suggestion.autoIndent;

        if (!/[a-zA-Z]/.test(suggestion.label[0])) {
            const editPosition: Position = {
                line: lineNum,
                character: colNum
            };
            item.textEdit = {
                newText: suggestion.label.slice(matchingLength) + (appendTab ? '\t' : ''),
                range: {
                    start: {
                        line: lineNum,
                        character: colNum - (beforeWord.length - matchingLength)
                    },
                    end: editPosition
                },
            };
        } else {
            item.insertText = suggestion.label + (appendTab ? '\t' : '');
        }

        result.push(item);
    });

    // return [{label:"Text",kind:CompletionItemKind.Text},{label:"Method",kind:CompletionItemKind.Method},{label:"Function",kind:CompletionItemKind.Function},{label:"Constructor",kind:CompletionItemKind.Constructor},{label:"Field",kind:CompletionItemKind.Field},{label:"Variable",kind:CompletionItemKind.Variable},{label:"Class",kind:CompletionItemKind.Class},{label:"Interface",kind:CompletionItemKind.Interface},{label:"Module",kind:CompletionItemKind.Module},{label:"Property",kind:CompletionItemKind.Property},{label:"Unit",kind:CompletionItemKind.Unit},{label:"Value",kind:CompletionItemKind.Value},{label:"Enum",kind:CompletionItemKind.Enum},{label:"Keyword",kind:CompletionItemKind.Keyword},{label:"Snippet",kind:CompletionItemKind.Snippet},{label:"Color",kind:CompletionItemKind.Color},{label:"File",kind:CompletionItemKind.File},{label:"Reference",kind:CompletionItemKind.Reference},{label:"Folder",kind:CompletionItemKind.Folder},{label:"EnumMember",kind:CompletionItemKind.EnumMember},{label:"Constant",kind:CompletionItemKind.Constant},{label:"Struct",kind:CompletionItemKind.Struct},{label:"Event",kind:CompletionItemKind.Event},{label:"Operator",kind:CompletionItemKind.Operator},{label:"TypeParameter",kind:CompletionItemKind.TypeParameter}];

    return result;
});

function getWordAtPosition(params: TextDocumentPositionParams) {
    const lineNum = params.position.line;
    const colNum = params.position.character;
    const uri = params.textDocument.uri;
    const line = (splitSources[uri] || [])[lineNum] || '';

    const before = line.slice(0, colNum);
    const after = line.slice(colNum);

    const beforeWord = (/\$?[a-zA-Z.0-9]*$/.exec(before) || [''])[0] || '';
    const afterWord = (/^\$?[a-zA-Z.0-9]*/.exec(after) || [''])[0] || '';

    // console.log({beforeWord, afterWord});

    return beforeWord + afterWord;
}

connection.onDefinition(params => {
    const uri = params.textDocument.uri;
    const definitions = getDefinitions(uri);
    const word = getWordAtPosition(params);

    const result: Location[] = [];

    for (let definition of definitions) {
        if (definition.identifier === word) {
            const line = definition.line;

            result.push({
                range: {
                    start: {
                        line,
                        character: 0
                    },
                    end: {
                        line,
                        character: Number.MAX_SAFE_INTEGER
                    }
                },
                uri: definition.sourceUri
            });
        }
    }
    // console.log({result});
    return result;
});

const MAX_INT32 = 2147483647;

connection.onDocumentSymbol(params => {
    // TODO: support SymbolInformation when the lsp client doesn't understand DocumentSymbol

    const symbols: DocumentSymbol[] = [];

    const definitions = getDefinitions(params.textDocument.uri);

    const stack: DocumentSymbol[] = [];

    definitions.forEach(definition => {
        if (definition.sourceUri !== params.textDocument.uri) {
            return;
        }

        const newSymbol = {
            kind: definition.type === 'label' ? SymbolKind.Class : SymbolKind.Constant,
            name: definition.identifier,
            range: {
                start: { character: 0, line: definition.line },
                end: { character: MAX_INT32, line: definition.line },
            },
            selectionRange: {
                start: { character: 0, line: definition.line },
                end: { character: MAX_INT32, line: definition.line },
            },
            children: definition.type === 'label' ? [] : undefined, // kinda hacky
        };

        let wasPushedToStack = false;

        while (stack.length) {
            if (definition.type !== 'label') {
                break;
            }

            if (definition.identifier.startsWith(stack[stack.length - 1].name + '__')) {
                stack[stack.length - 1].children?.push(newSymbol);
                wasPushedToStack = true;
                break;
            }

            stack.pop();
        }

        if (!wasPushedToStack) {
            symbols.push(newSymbol);
        }

        if (definition.type === 'label') {
            stack.push(newSymbol);
        }
    });

    symbols.reverse();

    function expandRanges(symbols: DocumentSymbol[], lastLine: number) {
        symbols.forEach(symbol => {
            if (symbol.children !== undefined) {
                symbol.range.end.line = Math.max(symbol.selectionRange.end.line, lastLine);

                symbol.children.reverse();
                expandRanges(symbol.children, lastLine);
                symbol.children.reverse();

                lastLine = symbol.range.start.line - 1;
            }
        });
    }

    expandRanges(symbols, splitSources[params.textDocument.uri].length);

    symbols.reverse();
    console.log(JSON.stringify(symbols, null, 2));

    return symbols;
});


documents.listen(connection);

connection.listen();
connection.console.log('Listening!');
