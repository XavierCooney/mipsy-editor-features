import {
    DebugSession, OutputEvent, LoadedSourceEvent,
    InitializedEvent, StoppedEvent, TerminatedEvent, InvalidatedEvent, ContinuedEvent
} from '@vscode/debugadapter';
import {
    DebugProtocol
} from '@vscode/debugprotocol';
import { make_new_runtime, DebugRuntime } from '../mipsy_vscode/pkg/mipsy_vscode';
import { ScanBuffer } from './scanBuffer';
import * as fs from 'node:fs/promises';

// const rand = Math.floor(Math.random() * 9000) + 1000;

const THREAD_ID = 1;
const STEPS_PER_INTERVAL = 300;

class MipsRuntime {
    private readonly runtime: DebugRuntime;
    private autoRunning: boolean;
    public inputNeeded: boolean;
    private resumeOnInput: boolean;
    public runningReverse: boolean;
    private isAtExit: boolean = false;

    constructor(readonly source: string, readonly filename: string, readonly path: string, readonly session: MipsSession, private readonly scanBuffer: ScanBuffer) {
        this.runtime = make_new_runtime(
            source, filename
        );
        this.autoRunning = false;
        this.inputNeeded = false;
        this.resumeOnInput = false;
        this.runningReverse = false;

        this.runAutoStep();
    }

    runAutoStep() {
        for (let i = 0; i < STEPS_PER_INTERVAL && this.autoRunning; ++i) {
            if (!this.runningReverse) {
                if (!this.step()) {
                    this.setAutorun(false, 'breakpoint');
                }
            } else {
                if (!this.stepBack()) {
                    this.setAutorun(false, 'breakpoint');
                }
            }
        }

        setTimeout(this.runAutoStep.bind(this), this.autoRunning ? 0 : 50);
    }

    setAutorun(auto: boolean, adapterReason: string) {
        if (this.autoRunning && !auto) {
            this.session.sendEvent(new StoppedEvent(adapterReason, THREAD_ID));
        }
        this.runningReverse = false;
        this.autoRunning = auto;
    }

    runReverse() {
        this.runningReverse = true;
        this.autoRunning = true;
    }

    sendToIOView(str: string, type: 'in' | 'out') {
        this.session.sendEvent({
            event: 'mipsyOutput',
            body: {
                segments: [{
                    str,
                    type
                }]
            },
            seq: 0,
            type: 'event'
        });
    }

    step(): boolean {
        if (this.isAtExit) {
            this.session.sendStdoutLine('exiting...');
            this.session.sendEvent(new TerminatedEvent());
            this.runtime.remove_runtime();
            return false;
        }

        const result = this.runtime.step_debug();

        if (result === 'StepSuccess') {
             return true;
        } else if (result === 'AtSyscallGuard') {
            const syscallGuard = this.runtime.get_syscall_type();

            if (syscallGuard === 'print') {
                const printResult = this.runtime.do_print();

                const match = /^([^:]*): (.*)$/s.exec(printResult) || [];
                const printType = match[1];
                const printContents = match[2];

                let sanitisedContents = printContents;
                if (printType === 'print_string') {
                    sanitisedContents = JSON.stringify(printContents);
                } else if (printType === 'print_char') {
                    if (printContents === '"') {
                        sanitisedContents = `'"'`;
                    } else if (printContents === "'") {
                        sanitisedContents = `'\\''`;
                    } else {
                        sanitisedContents = JSON.stringify(printContents).replaceAll(`"`, `'`);
                    }
                }

                if (printResult.length) {
                    this.session.sendStdoutLine(`syscall ${printType}: ${sanitisedContents}`);
                }

                this.sendToIOView(printContents, 'out');

                return true;
            } else if (syscallGuard === 'exit') {
                this.session.sendStdoutLine('syscall exit: press continue/next/stop to exit');
                this.isAtExit = true;
                return false;
            } else if (syscallGuard === 'breakpoint') {
                this.runtime.acknowledge_breakpoint();
                return !this.autoRunning; // stop the autorun, but don't stop single stepping
            } else if (syscallGuard.startsWith('read_')) {
                if (!this.scanBuffer.isExhausted) {
                    let result;
                    let todoSyscall = false;

                    if (syscallGuard === 'read_int') {
                        result = this.scanBuffer.readInt();
                    } else if (syscallGuard === 'read_character') {
                        result = this.scanBuffer.readChar();
                    } else {
                        todoSyscall = true;
                        this.session.sendStderrLine(
                            `Queued input with a ${syscallGuard} syscall not currently supported`
                        );
                    }

                    if (result === undefined) {
                        if (this.scanBuffer.isExhausted) {
                            this.session.sendStderrLine('All queued input now exhausted');
                        } else if (!todoSyscall) {
                            this.session.sendStderrLine(
                                `Invalid format encountered in queued input during ${syscallGuard} syscall: ${this.scanBuffer.initialContents()}. Queued input removed.`
                            );
                        }
                        this.scanBuffer.clear();
                    } else {
                        this.inputNeeded = true;
                        this.session.sendStdoutLine(`[from queued input] ${this.provideInput(result.toString())}`);

                        if (!this.inputNeeded) {
                            return true;
                        } else {
                            this.session.sendStderrLine('[clearing input queue due to above error]');
                            this.scanBuffer.clear();
                            this.inputNeeded = false;
                        }
                    }
                }

                if (this.inputNeeded) {
                    // we've already told the user to enter input, maybe say something different?
                    this.session.sendStderrLine(
                        `[enter your input to the ${syscallGuard} syscall next to the \`>\` in the box below]`
                    );
                } else {
                    this.inputNeeded = true;
                    this.session.sendStdoutLine(
                        `syscall ${syscallGuard}: [enter your input in the box below]`
                    );
                }

                this.resumeOnInput = this.autoRunning;

                return false;
            } else {
                this.session.sendDebugLine('unhandled syscall ' + syscallGuard);
                return false;
            }
        } else if (result === 'NoRuntime') {
            this.setAutorun(false, 'step');
            return false;
        } else if (typeof result === 'object' && result['StepError']) {
            const err = result['StepError'];
            this.session.sendStderrLine('An error has occured:\n' + err);
            this.setAutorun(false, 'step');
            return false;
        }

        this.session.sendDebugLine('result ' + JSON.stringify(result));
        return false;
    }

    stepBack() {
        this.isAtExit = false;
        this.inputNeeded = false;
        return this.runtime.step_back(this.autoRunning && this.runningReverse);
    }

    setBreakpoints(lines: number[]) {
        return Array.from(this.runtime.set_breakpoints_from_lines(
            new Uint32Array(lines)
        ));
    }

    getLineNum(): number | undefined {
        return this.runtime.get_line_num();
    }

    readRegisters() {
        const arrayData = Array.from(this.runtime.dump_registers());

        const writeMarker = arrayData[32];

        const generalPurposeRegisterNames = [
            'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
            't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
            's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
            't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'
        ];

        const result: {
            name: string, value: number
        }[] = [];

        generalPurposeRegisterNames.forEach((reg, idx) => {
            if (writeMarker & (1 << idx)) {
                result.push({
                    name: '$' + reg,
                    value: arrayData[idx]
                });
            }
        });

        if (arrayData[35]) {
            result.push({
                name: 'HI',
                value: arrayData[33]
            });
        }
        if (arrayData[36]) {
            result.push({
                name: 'LO',
                value: arrayData[34]
            });
        }

        result.push({
            name: 'PC',
            value: arrayData[37]
        });

        return result;
    }

    disassemble(start: number, count: number) {
        return this.runtime.perform_disassembly(start >>> 0, count >>> 0);
    }

    getPC() {
        return this.runtime.get_pc();
    }

    readMemory() {
        return Array.from(this.runtime.read_memory());
    }

    provideInput(input: string) {
        const sycallType = this.runtime.get_syscall_type();
        if (!sycallType.startsWith('read_')) {
            return 'not read syscall';
        }

        const result = this.runtime.provide_input(input);

        if (result === 'ok') {
            this.inputNeeded = false;

            if (this.resumeOnInput) {
                this.setAutorun(true, '');
                this.session.sendEvent(new ContinuedEvent(THREAD_ID));
            } else {
                // this.session.sendEvent(new InvalidatedEvent(undefined, THREAD_ID));
                this.session.sendEvent(new ContinuedEvent(THREAD_ID));
                this.session.sendEvent(new StoppedEvent('step', THREAD_ID));
            }

            this.sendToIOView(input.trimEnd() + '\n', 'in');

            return `syscall ${sycallType}: ${input}`;
        } else if (result) {
            return result;
            // this.session.sendStdoutLine(result);
        } else {
            this.session.sendDebugLine('empty result...');
            return 'error';
        }
    }
}

function numTo32BitHex(value: number) {
    return '0x' + value.toString(16).padStart(8, '0').toUpperCase();
}

// TODO: this is structured incredibly badly
class MipsSession extends DebugSession {
    private sourceFilePath: string = '';
    private source: string = '';
    private sourceName: string = '<source code>';
    private sourceLines: string[] = [];
    private initialBreakpoints: (() => void) | undefined;
    private isVSCode: boolean = false;
    private scanBuffer: ScanBuffer = new ScanBuffer();
    private delayedGotSource: (() => void) | undefined;

    private runtime: MipsRuntime | undefined;

    constructor() {
        super();
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};

        response.body.supportsStepBack = true;
        response.body.supportsConfigurationDoneRequest = true;

        response.body.supportsDisassembleRequest = true;
		// response.body.supportsSteppingGranularity = true;
		// response.body.supportsInstructionBreakpoints = true;

        // response.body.supportsReadMemoryRequest = true;
		// response.body.supportsWriteMemoryRequest = true;

        response.body.supportTerminateDebuggee = true;

        if (args.adapterID === 'mipsy-1' && args.clientID === 'vscode') {
            // TODO: make sure this is the same for vscodium
            this.isVSCode = true;
        }

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
        this.sendStdoutLine(`Please send bugs and feature requests here: https://github.com/XavierCooney/mipsy-editor-features :)`);
    }

    sendDebugLine(str: string) {
        this.sendEvent(new OutputEvent(`[debug] ${str}\n`, 'debug console'));
    }

    sendStdoutLine(str: string) {
        this.sendEvent(new OutputEvent(`${str}\n`, 'stdout'));
    }

    sendStderrLine(str: string) {
        this.sendEvent(new OutputEvent(`${str}\n`, 'stderr'));
    }

    sendError(str: string) {
        // oh no!
        this.sendEvent(new OutputEvent(`${str}\n`, 'important'));
    }

    getSource() {
        return {
            name: this.sourceName,
            path: this.sourceFilePath,
            sourceReference: 0
        };
    }

    sendSource() {
        // no idea if this is necessary
        this.sendEvent(new LoadedSourceEvent(
            'new', this.getSource()
        ));
    }

    protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request) {
        response.body = {
            content: this.source,
        };
        this.sendResponse(response);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: any, request?: DebugProtocol.Request | undefined): Promise<void> {
        const gotSource = () => {
            const splitter = this.source.indexOf('\r\n') === -1 ? '\n' : '\r\n';
            this.sourceLines = this.source.split(splitter).map(
                line => line.replaceAll('\r', '').replaceAll('\n', '')
            );

            try {
                this.runtime = new MipsRuntime(this.source, this.sourceName, this.sourceFilePath, this, this.scanBuffer);
            } catch (e) {
                this.sendError('Error:\n' + e);
                this.sendEvent(new TerminatedEvent());
                return;
            }

            if (this.initialBreakpoints) {
                this.initialBreakpoints();
            }

            this.sendResponse(response);

            this.sendEvent(new StoppedEvent(
                'entry',
                THREAD_ID
            ));
        };

        if (args.doCustomSourceSending?.uri) {
            this.sendDebugLine('loading source virtually');

            const uri = args.doCustomSourceSending.uri;

            this.sourceFilePath = uri;
            const pathParts = uri.split(/[\/\\]/);
            this.sourceName = pathParts[pathParts.length - 1];

            this.sendEvent({
                event: 'mipsySource',
                body: args.doCustomSourceSending,
                seq: 0,
                type: 'event'
            });

            this.delayedGotSource = gotSource;
        } else {
            this.sendDebugLine('loading source directly');
            // this.sendDebugLine(JSON.stringify(args, null, 2));

            const fsPath = args?.program?.fsPath || args?.program?.path;

            if (!fsPath) {
                return this.sendError('no path :(');
            }

            this.sourceFilePath = fsPath;

            try {
                const source = await fs.readFile(fsPath, 'utf8');
                this.source = source;
            } catch {
                this.sendError(`can't read the file :[`);
                this.sendEvent(new TerminatedEvent());
                return;
            }

            const pathParts = fsPath.split(/[\/\\]/);
            this.sourceName = pathParts[pathParts.length - 1];

            gotSource();
        }
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }

    protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {
        response.body = {
            threads: [{
                id: 1,
                name: 'thread name'
            }]
        };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
        this.runtime?.setAutorun(false, 'pause');
        this.sendEvent(new StoppedEvent('pause', THREAD_ID));
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request | undefined): void {
        this.sendResponse(response);
        this.runtime?.setAutorun(true, 'continue');
    }

    performStepNext() {
        if (this.runtime) {
            const oldLine = this.runtime.getLineNum();
            while (this.runtime.step()) {
                const newLine = this.runtime.getLineNum();
                // this.sendDebugLine(`old ${oldLine}, new ${newLine}, pc ${this.runtime.getPC()}`);
                if (newLine !== oldLine && newLine !== undefined) {
                    break;
                }
            }
        }
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request | undefined): void {
        this.performStepNext();
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request | undefined): void {
        if (this.runtime) {
            const oldPc = this.runtime.getPC();
            while (this.runtime.step()) {
                const newPc = this.runtime.getPC();
                if (newPc !== oldPc && newPc !== undefined) {
                    break;
                }
            }
        }

        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request | undefined): void {
        if (this.runtime) {
            const oldPc = this.runtime.getPC();
            while (this.runtime.stepBack()) {
                const newPc = this.runtime.getPC();
                if (newPc !== oldPc && newPc !== undefined) {
                    break;
                }
            }
        }
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }

    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, request?: DebugProtocol.Request | undefined): void {
        if (this.runtime) {
            const oldLine = this.runtime.getLineNum();
            while (this.runtime.stepBack()) {
                const newLine = this.runtime.getLineNum();
                if (newLine !== oldLine && newLine !== undefined) {
                    break;
                }
            }
        }
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }

    protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments, request?: DebugProtocol.Request | undefined): void {
        this.runtime?.runReverse();
        this.sendResponse(response);
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request | undefined): void {
        // this is a ui hack, but use the repl as the input box. in vscode it makes sense
        if (!args.context || args.context !== 'repl') {
            this.sendResponse(response);
            return;
        }

        let result = '';
        if (!this.runtime?.inputNeeded) {
            // this.sendError('not currently in input syscall!');
            // this.sendResponse(response);
            result = 'not currently in input syscall! Use `send to MIPS input` feature to queue up input.';
        } else {
            result = this.runtime.provideInput(args.expression);
        }

        response.body = {
            result,
            variablesReference: 0
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void {
        response.body = {
            totalFrames: 1,
            stackFrames: [{
                id: 1,
                name: '',
                line: this.runtime?.getLineNum() || 0,
                column: 1,
                source: this.getSource(),
                instructionPointerReference: numTo32BitHex(this.runtime?.getPC() || 0)
            }]
        };
        this.sendResponse(response);
    }

    protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request | undefined): void {
        let start = parseInt(args.memoryReference) + (args.instructionOffset || 0) * 4 + (args.offset || 0);

        response.body = {
            instructions: this.runtime?.disassemble(start, args.instructionCount)?.map((part: any) => {
                return {
                    address: numTo32BitHex(part.address),
                    instruction: part.instruction,
                    column: 1,
                    endColumn: Number.MAX_SAFE_INTEGER,
                    line: part.line_num,
                    endLine: part.line_num,
                    location: this.getSource(),
                    instructionBytes: part.instruction_bytes,
                    symbol: part.symbols
                };
            }) || []
        };

        this.sendResponse(response);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request | undefined): void {
        const breakpoints = args.breakpoints || [];

        let breakpointLines = breakpoints.map(
            breakpoint => breakpoint.line
        );

        let linesWithActualBreakpoints: number[] = [];

        const handleBreakpoints = () => {
            if (this.runtime) {
                const sourceLines = this.sourceLines;

                breakpointLines = breakpointLines.map(line => {
                    while (true) {
                        if (line >= sourceLines.length) {
                            break;
                        }

                        const sourceLine = sourceLines[line - 1];
                        const withoutComments = sourceLine.split('#')[0].trim();
                        if (withoutComments === '' || /^[A-Za-z_][A-Za-z_0-9.]*[ \t]*:$/.test(withoutComments)) {
                            line++;
                        } else {
                            break;
                        }
                    }

                    return line;
                });

                linesWithActualBreakpoints = this.runtime.setBreakpoints(breakpointLines);
                response.body = {
                    breakpoints: breakpoints.map((breakpoint, index) => ({
                        verified: linesWithActualBreakpoints.includes(breakpointLines[index]),
                        line: breakpointLines[index],
                        endLine: breakpointLines[index],
                    }))
                };

                this.sendResponse(response);
            } else {
                this.initialBreakpoints = handleBreakpoints;
            }
        };

        handleBreakpoints();
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = {
            scopes: [{
                name: 'Registers',
                presentationHint: 'registers',
                variablesReference: 7,
                expensive: false,
                source: this.getSource()
            }]
        };

        this.sendResponse(response);
    }

    protected renderRegisterValue(value: number) {
        // so this is probably not good, but as a heuristic, display small values (-1024 < x < 1024)
        // as two's complement decimal, and larger ones as unsigned hexadecimal, since they're more
        // likely to be addresses/bit fields/whatever
        if (-1024 < value && value < 1024) {
            return value.toString();
        } else {
            if (value < 0) {
                value += (1 << 30) * 4;
            }
            return numTo32BitHex(value);
        }
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = {
            variables: []
        };

        if (this.runtime) {
            const registers = this.runtime.readRegisters();
            for (let register of registers) {
                response.body.variables.push({
                    name: register.name,
                    value: this.renderRegisterValue(register.value),
                    presentationHint: {
                        kind: 'data',
                        // attributes: ['readOnly']
                    },
                    variablesReference: 0,
                });
            }

            this.sendMemoryEvent();
        }

        this.sendResponse(response);
    }

    sendMemoryEvent() {
        if (!this.runtime) {
            return;
        }

        const memory = this.runtime.readMemory();

        if (memory && memory.length) {
            this.sendEvent({
                event: 'mipsyMemory',
                body: {
                    memory
                },
                seq: 0,
                type: 'event'
            });
        }
    }

    public sendEvent(event: DebugProtocol.Event): void {
        if (event.event !== 'output') {
            // this.sendDebugLine(`event ${JSON.stringify(event)}`);
        }
        return super.sendEvent(event);
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any, request?: DebugProtocol.Request | undefined): void {
        if (command === 'queueInput') {
            if (this.scanBuffer.isExhausted) {
                this.sendStdoutLine('[input queued]');
            } else {
                this.sendStdoutLine('[previous input queue cleared, and new input queued]');
            }
            this.scanBuffer.clear();

            this.scanBuffer.addToQueue(args.contents);
            this.sendResponse(response);

            if (this.runtime?.inputNeeded) {
                this.runtime.step();
            }

            return;
        } else if (command === 'mipsySource') {
            this.source = args.source;
            const gotSource = this.delayedGotSource;
            if (gotSource) {
                this.delayedGotSource = undefined;
                gotSource();
            }
            this.sendResponse(response);
        }
    }

    protected dispatchRequest(request: DebugProtocol.Request) {
        // this.sendDebugLine(`request ${JSON.stringify(request)}`);
        return super.dispatchRequest(request);
    }

    sendResponse(response: DebugProtocol.Response): void {
        // this.sendDebugLine(`response ${JSON.stringify(response)}`);
        return super.sendResponse(response);
    }
}

const session = new MipsSession();
session.start(process.stdin, process.stdout);
