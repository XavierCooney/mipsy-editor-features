#!/usr/bin/env python3

import json
import yaml
import os

for dir in ['syntaxes', 'out']:
    os.makedirs(dir, exist_ok=True)


DIRECTIVES = [ # from mipsy_parser/src/directive.rs
    'text',
    'data',
    'ktext',
    'kdata',
    'ascii',
    'asciiz',
    'byte',
    'half',
    'word',
    'float',
    'double',
    'space',
    'align',
    'globl',
]

PARSE_SPACE0 = '[ \t]*' # https://docs.rs/nom/latest/nom/character/complete/fn.space0.html
PARSE_IDENT = '[A-Za-z_][A-Za-z_0-9.]*' # from misc.rs. Fun fact: you can have dots in label names!

all_patterns = []

def add_pattern(scope: str, match: str):
    if isinstance(scope, str):
        all_patterns.append({
            'name': f'{scope}.mips',
            'match': match
        })
    else:
        assert isinstance(scope, list)
        all_patterns.append({
            'captures': {
                str(i + 1): {
                    'name': f'{group_scope}.mips'
                }
                for i, group_scope in enumerate(scope)
            },
            'match': match
        })

def any_of(alternatives):
    return '|'.join(alternatives)

def read_instructions(key):
    with open(os.path.join('mipsy', 'mips.yaml')) as yaml_stream:
        doc = yaml.safe_load(yaml_stream)
        return [
            {
                'name': instruction['name'],
                'desc': instruction.get('desc_short', ''),
                'has_args': bool(instruction['compile']['format'])
            }
            for instruction in doc[key]
        ]

# add_pattern(
#     ['markup.italic'],
#     r'#[ \t]*<[ \t]*(multifile)[ \t]*\([^)\n]*\)[ \t]*>',
# )

# all_patterns.append({
#     "name": "comment.line.number-sign.mips",
#     "begin": "#",
#     "end": "\n",
#     "patterns": [{
#         "name": "keyword.control.multifile.mips",
#         "match": r"@[ \t]*<[ \t]*multifile[ \t]*\(([^)\n]*)\)[ \t]*>"
#     }]
# })

add_pattern(
    [
        'comment.line.number-sign',
        'keyword.control.multifile.mips',
        'string.multifile-control.mips',
        'keyword.control.multifile.mips',
        'comment.line.number-sign',
    ],
    r'(#[^\n@]*)(@[ \t]*\[[ \t]*multifile[ \t]*\()([^)\n]*)(\)[ \t]*\])([^\n]*)'
)

add_pattern('comment.line.number-sign', r'#.*$')


# don't bother with attributes
add_pattern(
    'keyword.control.directive',
    r'\.(' + any_of(DIRECTIVES) + r')\b'
)
add_pattern(
    ['support.class.label', 'punctuation.separator.label'],
    f'({PARSE_IDENT}){PARSE_SPACE0}(:)'
)

INSTRUCTIONS = read_instructions('instructions')
PSUEDO_INSTRUCTIONS = read_instructions('pseudoinstructions')

add_pattern(
    'support.function.instruction',
    r'(?i)\b(' + any_of(i['name'] for i in INSTRUCTIONS) + r')\b'
)
add_pattern(
    'support.function.pseudoinstructions',
    r'(?i)\b(' + any_of(i['name'] for i in PSUEDO_INSTRUCTIONS) + r')\b'
)

add_pattern(
    'entity.ident',
    f'{PARSE_IDENT}'
)

# mipsy will parse registers like $1abc23 and give a useful error later,
# but here we just highlight valid registers
add_pattern(
    'keyword.operator.register.numbered',
    r'\$([0-9]|1[0-9]|2[0-9]|3[01])\b'
)

NAMED_REGISTERS = [
    'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
    't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
    's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
    't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'
]

add_pattern(
    'keyword.operator.register.named',
    r'\$(' + any_of(NAMED_REGISTERS) + r')\b'
)

add_pattern(
    'string.quoted.double',
    r'''"(\\[0rnt\\\"\']|[^\\])*"'''
)

add_pattern( # number.rs
    'string.quoted.single',
    r"""'(\\[0rnt\\\"\']|[^\\])'"""
)

add_pattern( # todo: also parse float literals
    [
        'constant.numeric.minus-sign',
        'storage.type.number.hex', 'constant.numeric.hex',
        'storage.type.number.bin', 'constant.numeric.bin',
        'storage.type.number.oct', 'constant.numeric.oct',
        # 'storage.type.number.dec',
        'constant.numeric.dec',
    ],
    r'(-?)(?:(0x)([0-9a-fA-F]+)|(0b)([0-1]+)|(0o?)([0-7]+)|([1-9][0-9]*|0))(?!\d)' # <-- this regex was annoying to write
)

add_pattern(
    ['entity.name.function.constant', 'keyword.operator.assignment'],
    f'({PARSE_IDENT}){PARSE_SPACE0}(=)',
)

add_pattern(
    'punctuation.separator',
    r','
)

add_pattern(
    'keyword.operator',
    r'[-+/%&|^~]|<<|>>'
)

add_pattern(
    'meta.annotation.decompilation-marker',
    'Decompilation of ([^:\n]*):'
)

add_pattern(
    'invalid.illegal.decompilation-error',
    'Your MIPS program has an error so can\'t be dissassembled: ([^\n]*)'
)

with open(os.path.join('syntaxes', 'mips.tmLanguage.json'), 'w') as file:
    json.dump({
        'name': 'MIPS',
        'scopeName': 'source.mips',
        'patterns': all_patterns
    }, file, indent=2)



# also statically build all the suggestions for the completion provider in the lsp
static_completions = []

for directive in DIRECTIVES:
    static_completions.append({
        'label': f'.{directive}',
        'type': 'directive',
    })

for i, register in enumerate(NAMED_REGISTERS):
    static_completions.append({
        'label': f'${register}',
        'type': 'register',
        'sort_data': f'{i:02}'
    })

seen_instructions = set()
for instruction in INSTRUCTIONS + PSUEDO_INSTRUCTIONS:
    if instruction['name'] in seen_instructions: continue
    seen_instructions.add(instruction['name'])
    if instruction['name'].startswith('DBG_'): continue
    static_completions.append({
        'label': instruction['name'].lower(),
        'type': 'instruction',
        'docs': instruction['desc'],
        'autoIndent': instruction['has_args']
    })

SYSCALLS = {
    1: ('print int', True),
    2: ('print float', False),
    3: ('print double', False),
    4: ('print string', True),
    5: ('read int', True),
    6: ('read float', False),
    7: ('read double', False),
    8: ('read string', False),
    9: ('sbrk', False),
    10: ('exit', False),
    11: ('print character', True),
    12: ('read character', True),
    13: ('open file', False),
    14: ('read file', False),
    15: ('write file', False),
    16: ('close file', False),
    17: ('exit2', False),
}

for syscall_num, syscall_info in SYSCALLS.items():
    name, is_common = syscall_info
    static_completions.append({
        'label': str(syscall_num),
        'type': 'syscall_num',
        'docs': name,
        'syscall_common': is_common,
        'sort_data': f'{syscall_num:02}'
    })

for dir in ['src', 'out']:
    with open(os.path.join(dir, 'lsp_data.json'), 'w') as file:
        json.dump({
            'suggestions': static_completions
        }, file, indent=2)
