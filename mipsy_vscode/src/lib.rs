use std::{rc::Rc, collections::HashSet, str::FromStr, fmt::Display};
use serde::{Serialize, Deserialize};
use mipsy_parser::TaggedFile;
use wasm_bindgen::prelude::*;
use mipsy_lib::{compile::CompilerOptions, MipsyError, InstSet, Binary, runtime::{SteppedRuntime, RuntimeSyscallGuard, PAGE_SIZE}, Runtime, error::runtime::ErrorContext, util::{get_segment, Segment}, TEXT_BOT, KTEXT_BOT, Safe, decompile::decompile_inst_into_parts};
use mipsy_utils::MipsyConfig;



#[derive(Serialize, Deserialize, Clone)]
pub struct ErrorReport {
    message: String,
    localised: bool,
    tips: Vec<String>,
    file_tag: String,
    line: u32,
    col: u32,
    col_end: u32,
    is_warning: bool,
    is_multfile_related: bool
}

#[derive(Serialize, Deserialize)]
pub struct ValidationResult {
    errors: Vec<ErrorReport>
}

#[derive(Serialize, Deserialize)]
struct FilenameAndSource {
    filename: String,
    source: String
}

fn check_source(iset: &InstSet, filename: &str, source: &str, compiler_options: &CompilerOptions, config: &MipsyConfig, extra_files: &[FilenameAndSource]) -> Option<ErrorReport> {
    let mut tagged_files = vec![TaggedFile::new(Some(filename), source)];
    tagged_files.extend(extra_files.iter().map(|extra_file| {
        TaggedFile::new(Some(&extra_file.filename), &extra_file.source)
    }));

    match mipsy_lib::compile(
        iset, tagged_files,
        compiler_options, config
    ) {
        Ok(_) => None,
        Err(err) => match err {
            MipsyError::Parser(parse_err) => Some(ErrorReport {
                message: String::from("Parse failure: check your syntax!"), // is there actually no further info?
                localised: true,
                file_tag: (*parse_err.file_tag()).to_owned(),
                line: parse_err.line(),
                col: parse_err.col(),
                col_end: parse_err.col(),
                tips: vec![],
                is_warning: false,
                is_multfile_related: false
            }),
            MipsyError::Compiler(compile_err) => Some(ErrorReport {
                message: compile_err.error().message(),
                localised: compile_err.error().should_highlight_line(),
                file_tag: (*compile_err.file_tag()).to_owned(),
                line: compile_err.line(),
                col: compile_err.col(),
                col_end: compile_err.col_end(),
                tips: compile_err.error().tips(),
                is_warning: false,
                is_multfile_related: false
            }),
            MipsyError::Runtime(_) => None, // should be unreachable?
        }
    }
}

#[wasm_bindgen]
pub fn test_compile(primary_source: &str, primary_filename: &str, other_files: JsValue, max_problems: usize) -> Result<JsValue, JsValue>  {
    let compiler_options = &CompilerOptions::new(vec![]);
    let config = &MipsyConfig::default();
    let iset = &mipsy_instructions::inst_set();

    let mut all_errors: Vec<ErrorReport> = vec![];
    let mut error_lines: Vec<u32> = vec![];

    let other_files: Vec<_> = serde_wasm_bindgen::from_value(other_files)?;

    while all_errors.len() < max_problems {
        let err = check_source(
            iset, primary_filename,
            &primary_source
                .lines()
                .enumerate()
                .map(|(i, line)| {
                    if error_lines.contains(&u32::try_from(i).unwrap()) {
                        ""
                    } else {
                        line
                    }
                })
                .collect::<Vec<&str>>().join("\n"),
            compiler_options, config, &other_files
        );

        match err {
            None => break,
            Some(err) => {
                if err.file_tag != primary_filename && !err.file_tag.is_empty() && !other_files.is_empty() {
                    if all_errors.is_empty() {
                        all_errors.push(ErrorReport {
                            message: std::format!("there's an error in another file ({}: {}), which may be obscuring errors in this one", err.file_tag, err.message),
                            localised: false,
                            tips: vec![],
                            file_tag: primary_filename.to_owned(),
                            line: 0,
                            col: 0,
                            col_end: 0,
                            is_warning: true,
                            is_multfile_related: true
                        })
                    }

                    // different file - just give up now
                    break;
                }

                if error_lines.iter().any(|line| err.line <= *line) {
                    // error occured before a previously received error - probably spurious
                    break;
                }

                let line = err.line - 1;
                let localised = err.localised;

                all_errors.push(err);

                if !localised {
                    break;
                }

                error_lines.push(line);
            },
        }
    }

    Ok(serde_wasm_bindgen::to_value(&ValidationResult {
        errors: all_errors
    })?)
}

fn compile_from_source(source: &str, filename: &str, reason: &str, iset: &InstSet) -> Result<Binary, String> {
    let compiler_options = &CompilerOptions::new(vec![]);
    let config = &MipsyConfig::default();

    match mipsy_lib::compile(
        iset, vec![TaggedFile::new(Some(filename), source)],
        compiler_options, config
    ) {
        Ok(binary) => Ok(binary),
        Err(_) => match check_source(iset, filename, source, compiler_options, config, &[]) {
            Some(err) => Err(std::format!(
                "Your MIPS program has an error so can't be {}: {}{}",
                reason,
                if err.localised {
                    std::format!("line {}: ", err.line)
                } else {
                    "".into()
                },
                err.message
            )),
            None => {
                Err("Hmm you've got a rather mysterious compiler error.".into())
            }
        }
    }
}

#[wasm_bindgen]
pub fn decompile_source(source: &str, filename: &str) -> String {
    let iset = &mipsy_instructions::inst_set();

    compile_from_source(source, filename, "dissassembled", iset).map(
        |binary| mipsy_lib::decompile(iset, &binary)
    ).unwrap_or_else(|msg| msg)
}

struct RegisterCache {
    registers: [i32; 32],
    write_marks: u32,
    hi: Option<i32>,
    lo: Option<i32>,
    pc: Option<u32>
}

#[wasm_bindgen]
pub struct DebugRuntime {
    mipsy_runtime: Option<SteppedRuntime>,
    binary: Binary,
    breakpoint_addrs: HashSet<u32>,
    registers: Option<RegisterCache>,
    last_pc: Option<u32>,
    iset: InstSet,
    sources: Vec<(Rc<str>, Rc<str>)>
}

#[derive(Serialize, Deserialize)]
pub enum StepResult {
    AtSyscallGuard, StepSuccess, NoRuntime, StepError(String)
}

#[derive(Serialize, Deserialize)]
pub struct DisassembleResponse {
    address: u32,
    instruction: String,
    line_num: Option<u32>,
    instruction_bytes: Option<String>,
    symbols: Option<String>
}

#[wasm_bindgen]
impl DebugRuntime {
    pub fn step_debug(&mut self) -> Result<JsValue, JsValue> {
        let step_result = match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                match runtime.step() {
                    Ok(new_stepped_runtime) => {
                        self.mipsy_runtime = Some(new_stepped_runtime);
                        self.invalidate_register_cache();

                        StepResult::StepSuccess
                    }
                    Err((old_runtime, mipsy_error)) => {
                        // StepResult::StepError(":(".into())
                        let msg = StepResult::StepError(match mipsy_error {
                            MipsyError::Parser(_) | MipsyError::Compiler(_) =>
                                "A parser/compiler error?!".into(),
                            MipsyError::Runtime(err) => {
                                err.error().message(
                                    ErrorContext::Binary,
                                    &self.sources,
                                    &self.iset,
                                    &self.binary,
                                    &old_runtime
                                ).trim().into()
                            },
                        });

                        self.mipsy_runtime = Some(Ok(old_runtime));
                        self.invalidate_register_cache();

                        msg
                    }
                }
            }
            Some(Err(guard)) => {
                self.mipsy_runtime = Some(Err(guard));
                StepResult::AtSyscallGuard
            }
            None => StepResult::NoRuntime
        };

        self.check_for_breakpoint();

        Ok(serde_wasm_bindgen::to_value(&step_result)?)
    }

    pub fn perform_disassembly(&self, start_address: u32, count: u32) -> Result<JsValue, JsValue> {
        let mut response: Vec<DisassembleResponse> = Default::default();
        let binary = &self.binary;
        let iset = &self.iset;

        for i in 0..count {
            let address = start_address + 4 * i;
            let word = (|| {
                let address = address;
                let line_num = self.binary.line_numbers.get(&address).map(
                    |&(_, line_num)| line_num
                );

                let (index, vec) = match get_segment(address) {
                    Segment::Text => Some((address - TEXT_BOT, &binary.text)),
                    Segment::KText => Some((address - KTEXT_BOT, &binary.ktext)),
                    _ => None
                }?;
                let index: usize = index.try_into().ok()?;
                // let bytes = vec.get(index..index+4)?;
                #[allow(clippy::identity_op)]
                let byte1 = *vec.get(index + 0)?;
                let byte2 = *vec.get(index + 1)?;
                let byte3 = *vec.get(index + 2)?;
                let byte4 = *vec.get(index + 3)?;
                match (|| {
                    Some(u32::from_le_bytes([
                        *byte1.as_option()?, *byte2.as_option()?,
                        *byte3.as_option()?, *byte4.as_option()?,
                    ]))
                })() {
                    Some(value) => Some((address, line_num, Safe::Valid(value))),
                    None => Some((address, line_num, Safe::Uninitialised))
                }
            })();

            response.push(match word {
                Some((text_addr, line_num, Safe::Valid(word))) => {
                    let decompiled = decompile_inst_into_parts(
                        binary, iset, word, text_addr
                    );
                    DisassembleResponse {
                        address,
                        instruction: std::format!(
                            "{:7} {}",
                            decompiled.inst_name.unwrap_or("[unknown instruction]".into()),
                            decompiled.arguments.join(", ")
                        ),
                        line_num,
                        instruction_bytes: Some(std::format!(
                            "0x{:08X}",
                            word
                        )),
                        symbols: None
                    }
                },
                Some((_, line_num, Safe::Uninitialised)) => DisassembleResponse {
                    address,
                    instruction: "[uninitialised]".into(),
                    line_num,
                    instruction_bytes: Some("  ????????".into()),
                    symbols: None
                },
                None => DisassembleResponse {
                    address,
                    instruction: "".into(),
                    line_num: None,
                    instruction_bytes: None,
                    symbols: None
                }
            });
        }

        Ok(serde_wasm_bindgen::to_value(&response)?)
    }

    pub fn get_syscall_type(&self) -> String {
        use mipsy_lib::runtime::RuntimeSyscallGuard::*;
        match &self.mipsy_runtime {
            Some(Ok(_)) => "none",
            Some(Err(guard)) => match guard {
                PrintInt(_, _) => "print",
                PrintFloat(_, _) => "print",
                PrintDouble(_, _) => "print",
                PrintString(_, _) => "print",
                PrintChar(_, _) => "print",
                ReadInt(_) => "read_int",
                ReadFloat(_) => "read_float",
                ReadDouble(_) => "read_double",
                ReadChar(_) => "read_character",
                ReadString(_, _) => "read_string",
                Sbrk(_, _) => "sbrk",
                Exit(_) => "exit",
                Open(_, _) => "open",
                Read(_, _) => "read",
                Write(_, _) => "write",
                Close(_, _) => "close",
                ExitStatus(_, _) => "exit",
                Breakpoint(_) => "breakpoint",
                Trap(_) => "trap",
            }
            None => "none"
        }.into()
    }

    pub fn do_print(&mut self) -> String {
        use mipsy_lib::runtime::RuntimeSyscallGuard::*;

        let print_result = match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                self.mipsy_runtime = Some(Ok(runtime));
                "".into()
            }
            Some(Err(guard)) => match guard {
                PrintInt(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_int: {}",  args.value)
                },
                PrintFloat(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_float: {}",  args.value)
                },
                PrintDouble(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_double: {}",  args.value)
                },
                PrintString(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_string: {}",  String::from_utf8_lossy(&args.value))
                },
                PrintChar(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_char: {}",  args.value as char)
                },
                guard => {
                    self.mipsy_runtime = Some(Err(guard));
                    "".into()
                }
            }
            None => "".into()
        };

        self.invalidate_register_cache();
        self.check_for_breakpoint();

        print_result
    }

    pub fn provide_input(&mut self, input: String) -> String {
        use mipsy_lib::runtime::RuntimeSyscallGuard::*;

        let mut user_message: String = "".into();

        // rust is awesome
        fn parse_input<T>(guard: Box<dyn FnOnce(T) -> Runtime>, variant: fn(Box<dyn FnOnce(T) -> Runtime>) -> RuntimeSyscallGuard, input: &str) -> (Option<SteppedRuntime>, String)
        where
            T: FromStr + Display,
            <T as FromStr>::Err: Display,
        {
            match input.parse() {
                Ok(value) => (Some(Ok(guard(value))), "ok".into()),
                Err(err) => {
                    (
                        Some(Err(variant(guard))),
                        std::format!("invalid input: {}", err)
                    )
                }
            }
        }

        match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                self.mipsy_runtime = Some(Ok(runtime));
            }
            Some(Err(guard)) => match guard {
                ReadInt(guard) => {
                    (self.mipsy_runtime, user_message) = parse_input(
                        guard, ReadInt, input.trim()
                    );
                },
                ReadFloat(guard) => {
                    (self.mipsy_runtime, user_message) = parse_input(
                        guard, ReadFloat, input.trim()
                    );
                },
                ReadDouble(guard) => {
                    (self.mipsy_runtime, user_message) = parse_input(
                        guard, ReadDouble, input.trim()
                    );
                },
                ReadChar(guard) => {
                    let bytes = input.as_bytes();
                    let maybe_char = if bytes.len() == 1 { bytes.first() } else { None };
                    (self.mipsy_runtime, user_message) = if let Some(char) = maybe_char {
                        (Some(Ok(guard(*char))), "ok".into())
                    } else {
                        (Some(Err(ReadChar(guard))), if bytes.is_empty() {
                            "invalid input: no character provided!"
                        } else {
                            "invalid input: too many characters provided!" // or non-ascii
                        }.into())
                    }
                },
                ReadString(args, guard) => {
                    let bytes = input.into_bytes();
                    (self.mipsy_runtime, user_message) = if bytes.len() > args.max_len as usize {
                        (Some(Ok(guard(bytes))), "ok".into())
                    } else {
                        (Some(Err(ReadString(args, guard))), "invalid input: string too long!".into())
                    }
                }
                guard => {
                    self.mipsy_runtime = Some(Err(guard));
                }
            }
            None => ()
        };

        self.invalidate_register_cache();
        self.check_for_breakpoint();

        user_message
    }

    pub fn acknowledge_breakpoint(&mut self) {
        match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                self.mipsy_runtime = Some(Ok(runtime));
            },
            Some(Err(guard)) => match guard {
                mipsy_lib::runtime::RuntimeSyscallGuard::Breakpoint(runtime) => {
                    self.mipsy_runtime = Some(Ok(runtime));
                    self.invalidate_register_cache();
                },
                guard => {
                    self.mipsy_runtime = Some(Err(guard))
                }
            },
            None => ()
        }
    }

    pub fn check_for_breakpoint(&mut self) {
        if let Some(Ok(runtime)) = &self.mipsy_runtime {
            if self.breakpoint_addrs.contains(&runtime.timeline().state().pc()) {
                self.mipsy_runtime = Some(Err(mipsy_lib::runtime::RuntimeSyscallGuard::Breakpoint(
                    self.mipsy_runtime.take().unwrap().ok().unwrap() // ughh
                )))
            }
        }
    }

    fn invalidate_register_cache(&mut self) {
        if let Some(Ok(runtime)) = &self.mipsy_runtime {
            self.last_pc = Some(runtime.timeline().state().pc());
        }

        self.registers = None
    }

    fn ensure_registers(&mut self) {
        if self.registers.is_some() {
            return
        };

        let (runtime, step_afterwards) = match self.force_get_runtime() {
            Some(pair) => pair,
            None => {
                self.registers = Some(RegisterCache {
                    pc: None,
                    registers: [0; 32],
                    write_marks: 0,
                    hi: None,
                    lo: None
                });
                return
            }
        };

        let state = runtime.timeline().state();
        let mut registers = RegisterCache {
            pc: Some(state.pc()),
            registers: [0; 32],
            write_marks: 0,
            hi: state.read_hi().ok(),
            lo: state.read_lo().ok()
        };

        for i in 0..32 {
            if let mipsy_lib::Safe::Valid(val) = state.registers()[i] {
                registers.registers[i] = val;
                registers.write_marks |= 1 << i;
            }
        }

        self.registers = Some(registers);

        self.mipsy_runtime = if step_afterwards {
            Some(runtime.step().unwrap_or_else(|(runtime, _)| Ok(runtime)))
        } else {
            Some(Ok(runtime))
        };
    }

    pub fn get_pc(&self) -> Option<u32> {
        self.last_pc
    }

    pub fn dump_registers(&mut self) -> Vec<i32> {
        let mut vec: Vec<i32> = Vec::with_capacity(38);

        self.ensure_registers();
        match &self.registers {
            Some(registers) => {
                vec.extend_from_slice(registers.registers.as_slice());
                vec.push(registers.write_marks as i32);
                vec.push(registers.hi.unwrap_or(0));
                vec.push(registers.lo.unwrap_or(0));
                vec.push(registers.hi.is_some().into());
                vec.push(registers.lo.is_some().into());
                vec.push(registers.pc.unwrap_or(0) as i32);
            }
            None => {
                vec.extend_from_slice(&[0; 32])
            }
        }

        vec
    }

    pub fn get_line_num(&mut self) -> Option<u32> {
        self.get_pc().filter(|&pc| pc <= mipsy_lib::compile::TEXT_TOP).and_then(
            |pc| self.binary.line_numbers.get(&pc).or_else(|| {
                // from get_line_info in runtime_handler.rs
                let mut lines = self.binary.line_numbers
                    .iter()
                    .filter(|&(&addr, _)| addr <= pc)
                    .collect::<Vec<_>>();
                lines.sort_unstable_by_key(|&(&addr, _)| addr);
                lines.last().map(|&(_, pair)| pair)
            })
        ).map(
            |(_, line)| *line
        )
    }

    fn force_get_runtime(&mut self) -> Option<(Runtime, bool)> {
        match self.mipsy_runtime.take() {
            None => None,
            Some(Ok(runtime)) => Some((runtime, false)),
            Some(Err(guard)) => {
                let mut runtime = match guard {
                    // we might be at a syscall guard - but in order to
                    // access previous states we need a Runtime. so to
                    // get a Runtime we pretend to actually run the syscall,
                    // so that we can then rewind time
                    RuntimeSyscallGuard::PrintInt(_, r) => r,
                    RuntimeSyscallGuard::PrintFloat(_, r) => r,
                    RuntimeSyscallGuard::PrintDouble(_, r) => r,
                    RuntimeSyscallGuard::PrintString(_, r) => r,
                    RuntimeSyscallGuard::PrintChar(_, r) => r,
                    RuntimeSyscallGuard::ReadInt(r) => r(0),
                    RuntimeSyscallGuard::ReadFloat(r) => r(0f32),
                    RuntimeSyscallGuard::ReadDouble(r) => r(0f64),
                    RuntimeSyscallGuard::ReadChar(r) => r(0),
                    RuntimeSyscallGuard::ReadString(_, r) => r(vec![]),
                    RuntimeSyscallGuard::Sbrk(_, r) => r,
                    RuntimeSyscallGuard::Exit(r) => r,
                    RuntimeSyscallGuard::Open(_, r) => r(0),
                    RuntimeSyscallGuard::Read(_, r) => r((0, vec![])),
                    RuntimeSyscallGuard::Write(_, r) => r(0),
                    RuntimeSyscallGuard::Close(_, r) => r(0),
                    RuntimeSyscallGuard::ExitStatus(_, r) => r,
                    RuntimeSyscallGuard::Breakpoint(r) => r,
                    RuntimeSyscallGuard::Trap(r) => r,
                };
                runtime.timeline_mut().pop_last_state();
                Some((runtime, true))
            }
        }
    }

    pub fn step_back(&mut self, stop_on_breakpoint: bool) -> bool {
        let (mut runtime, _) = match self.force_get_runtime() {
            Some(runtime) => runtime,
            None => return false
        };

        let success = runtime.timeline_mut().pop_last_state();
        self.mipsy_runtime = Some(Ok(runtime));

        self.invalidate_register_cache();

        let hit_breakpoint = stop_on_breakpoint && self.breakpoint_addrs.contains(&self.get_pc().unwrap_or(0));

        success && !hit_breakpoint
    }

    pub fn remove_runtime(&mut self) {
        self.mipsy_runtime = None;
    }

    pub fn read_memory(&mut self) -> Vec<u32> {
        let (runtime, step_afterwards) = match self.force_get_runtime() {
            Some(pair) => pair,
            None => return vec![]
        };

        let pages = runtime.timeline().state().pages();

        #[allow(clippy::match_like_matches_macro)]
        let mut pages = pages.iter().filter(
            |&(&addr, _)| match get_segment(addr) {
                Segment::Data => true,
                Segment::Stack => true,
                _ => false
            }
        ).collect::<Vec<_>>();
        pages.sort_unstable_by_key(
            |&(&addr, _)| addr
        );

        let mut result = Vec::with_capacity(pages.len() * (PAGE_SIZE + 1) + 1);
        result.push(PAGE_SIZE as u32);

        for (&addr, contents) in pages {
            result.push(addr);
            result.extend(contents.iter().map(|&val| match val {
                mipsy_lib::Safe::Valid(val) => (val as u32) + 1,
                mipsy_lib::Safe::Uninitialised => 0
            }));
        }

        self.mipsy_runtime = if step_afterwards {
            Some(runtime.step().unwrap_or_else(|(runtime, _)| Ok(runtime)))
        } else {
            Some(Ok(runtime))
        };

        result
    }

    pub fn set_breakpoints_from_lines(&mut self, breakpoint_lines: Vec<u32>) -> Vec<u32> {
        if breakpoint_lines.is_empty() {
            self.breakpoint_addrs.clear();
            return vec![];
        }

        let memory_locations = self.binary.line_numbers.iter().filter(
            |(_, (_, line))| breakpoint_lines.contains(line)
        ).collect::<Vec<_>>();

        self.breakpoint_addrs = memory_locations.iter().map(|(&addr, _)| addr).collect();

        memory_locations.iter().map(
            |(_, &(_, line))| line
        ).collect()
    }
}

#[wasm_bindgen]
pub fn make_new_runtime(source: &str, filename: &str) -> Result<DebugRuntime, String> {
    let iset = mipsy_instructions::inst_set();

    compile_from_source(source, filename, "run", &iset).map(
        |binary| {
            let mut runtime = DebugRuntime {
                binary: binary.to_owned(),
                mipsy_runtime: Some(Ok(mipsy_lib::runtime(&binary, &[]))),
                breakpoint_addrs: HashSet::new(),
                registers: None,
                last_pc: None,
                iset,
                sources: vec![(filename.into(), source.into())]
            };
            runtime.invalidate_register_cache();
            runtime
        }
    )
}
