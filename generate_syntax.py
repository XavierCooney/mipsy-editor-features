#!/usr/bin/env python3

import json
import yaml
import os


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
            instruction['name']
            for instruction in doc[key]
        ]

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

add_pattern(
    'support.function.instruction',
    r'(?i)\b(' + any_of(read_instructions('instructions')) + r')\b'
)
add_pattern(
    'support.function.pseudoinstructions',
    r'(?i)\b(' + any_of(read_instructions('pseudoinstructions')) + r')\b'
)

# mipsy will parse registers like $1abc23 and give a useful error later,
# but here we just highlight valid registers
add_pattern(
    'keyword.operator.register.numbered',
    r'\$([0-9]|1[0-9]|2[0-9]|3[01])\b'
)
add_pattern(
    'keyword.operator.register.named',
    r'\$(' + any_of([
        'zero', 'at', 'gp', 'sp', 'fp', 'ra',
        'v[0-1]', 'a[0-3]', 't[0-9]', 's[0-7]', 'k[0-1]'
    ]) + r')\b'
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
    r'(-?)(?:(0x)([0-9a-fA-F]+)|(0b)([0-1]+)|(0o?)([0-7]+)|([1-9][0-9]*))(?!\d)' # <-- this regex was annoying to write
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
