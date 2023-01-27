import { provideVSCodeDesignSystem, vsCodeDropdown } from "@vscode/webview-ui-toolkit";
import { vsCodeOption } from "@vscode/webview-ui-toolkit/dist/option";

provideVSCodeDesignSystem().register(vsCodeDropdown(), vsCodeOption());

const bytesPerRowDropdown = document.getElementById('dropdown-bytes-per-row') as HTMLSelectElement;
const vscode = acquireVsCodeApi();

let bytesPerRowSelected = false;

function sendRequest(selectedBytesPerRow: number | null) {
    vscode.postMessage({
        command: 'mem please!',
        selectedBytesPerRow
    });
}

sendRequest(null);

bytesPerRowDropdown?.addEventListener('change', e => {
    bytesPerRowSelected = true;
    sendRequest(
        bytesPerRowDropdown.selectedIndex
    );
});

function readBytesPerRow() {
    return parseInt(bytesPerRowDropdown.selectedOptions[0]?.value);
}

window.addEventListener('message', e => {
    // (document.getElementById('list-data') as HTMLElement).innerText = JSON.stringify(e.data);
    if (e.data.selectedBytesPerRow !== -1 && !bytesPerRowSelected) {
        bytesPerRowDropdown.selectedIndex = e.data.selectedBytesPerRow;
    }

    handleData(e.data.data);
});

// From mipsy_lib/src/compile/mod.rs
const TEXT_BOT    = 0x00400000;
const TEXT_TOP    = 0x0FFFFFFF;
const GLOBAL_BOT  = 0x10000000;
const GLOBAL_PTR  = 0x10008000;
const DATA_BOT    = 0x10010000;
const HEAP_BOT    = 0x10040000;
const STACK_BOT   = 0x7FFF0000;
const STACK_PTR   = 0x7FFFFFFC;
const STACK_TOP   = 0x7FFFFFFF;
const KTEXT_BOT   = 0x80000000;
const KDATA_BOT   = 0x90000000;

function toHex(value: number, digits: number) {
    return value.toString(16).padStart(digits, '0').toUpperCase();
}

function showByteAsEscaped(byte: number) {
    switch (byte) {
        case 0: return '0';
        case 9: return 't';
        case 10: return 'n';
        case 13: return 'r';
    }
    return '';
}

function handleData(data: number[]) {
    const bytesPerRow = readBytesPerRow() || 8;

    const outer = document.getElementById('outer') as HTMLElement;
    if (data.length === 0) {
        outer.innerHTML = `<h3>No data yet...</h3>`;
        return;
    }

    const pageSize = data[0];
    const pages = [];

    for (let i = 1; i < data.length;) {
        const address = data[i++];
        const page: { address: number, data: (number | null)[] } = {
            address,
            data: []
        };
        for (let j = 0; j < pageSize; ++j) {
            let byte: number | null = data[i++];
            if (byte === 0) {
                byte = null;
            } else {
                byte--;
            }
            page.data.push(byte);
        }
        console.log(i, data[i]);
        pages.push(page);
    }

    if (pages.length === 0) {
        outer.innerHTML = `<h3>No data stored in the data segment or on the stack</h3>`;
        return;
    }

    outer.innerHTML = ``;

    let lastSegmentType = undefined;

    for (let page of pages) {
        let segmentType = undefined;
        // const { address } = page;
        const address = page.address;

        // get_segment, mipsy_lib/src/util.rs
        if (address < TEXT_BOT) {
            segmentType = `None ${address}`;
        } else if (TEXT_BOT <= address && address <= TEXT_TOP) {
            segmentType = 'Text segment';
        } else if (GLOBAL_BOT <= address && address < STACK_BOT) {
            segmentType = 'Data segment';
        } else if (STACK_BOT <= address && address <= STACK_TOP) {
            segmentType = 'Stack';
        } else if (KTEXT_BOT <= address && address < KDATA_BOT) {
            segmentType = 'Kernel text segment';
        } else if (address >= KDATA_BOT) {
            segmentType = 'Kernel data segment';
        } else {
            segmentType = 'Unknown';
        }

        if (lastSegmentType !== segmentType) {
            lastSegmentType = segmentType;
            const h3 = document.createElement('h3');
            h3.innerText = segmentType;
            outer.appendChild(h3);
        }

        const table = document.createElement('table');

        for (let i = 0; i < pageSize; i += bytesPerRow) {
            const row = table.insertRow();
            const addressCell = row.insertCell();
            addressCell.classList.add('address-cell');

            addressCell.innerText = '0x' + toHex(i + address, 8);

            for (let isAscii = 0; isAscii <= 1; ++isAscii) {
                if (isAscii) {
                    const gapCell = row.insertCell();
                    gapCell.classList.add('hex-ascii-gap-cell');
                }

                for (let j = 0; j < bytesPerRow; ++j) {
                    if (j !== 0 && j % 4 === 0) {
                        const gapCell = row.insertCell();
                        gapCell.classList.add('word-gap-cell');
                    }

                    const dataCell = row.insertCell();
                    dataCell.classList.add('data-cell');
                    const value = page.data[i + j];

                    if (!isAscii) {
                        dataCell.innerText = value === null ? '?' : toHex(value, 2);
                    } else {
                        if (value === null) {
                            dataCell.innerText = '?';
                        } else if (32 <= value && value < 127) {
                            dataCell.innerText = String.fromCodePoint(value);
                        } else if (showByteAsEscaped(value)) {
                            dataCell.innerText = '\\' + showByteAsEscaped(value);
                        } else {
                            dataCell.innerText = '.';
                            dataCell.classList.add('data-non-ascii');
                        }
                    }

                    if (value === null) {
                        dataCell.classList.add('data-uninitialised');
                    }

                    const titleComponents = ['0x' + toHex(page.address + i + j, 8)];
                    if (value !== null && !isAscii) {
                        titleComponents.push(`(0x${toHex(value, 2)} = dec ${value})`);
                    }

                    dataCell.title = titleComponents.join('\n');
                }
            }
        }

        outer.appendChild(table);
    }

    let allDataCells = Array.from(document.getElementsByClassName('data-cell'));

    const maxWidth = Math.max(...allDataCells.map(cell => cell.clientWidth));
    allDataCells.forEach(cell => {
        (cell as HTMLElement).style.minWidth = `${maxWidth}px`;
    });
}