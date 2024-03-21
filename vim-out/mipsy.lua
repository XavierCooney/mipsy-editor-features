return {
    setup = function()
        -- register the 'mips' filetype (use pattern to have higher
        -- priority over native asm filetype)
        vim.filetype.add({
            pattern = { ['.*%.s'] = { 'mips', { priority = 10 } } }
        })

        -- make a custom lspconfig
        local lspconfig = require('lspconfig')
        require('lspconfig.configs').mipsy_editor_features = {
            default_config = {
                cmd = { vim.fn.expand('~/src/mipsy-editor-features/vim-out/mipsy-lsp.sh') },
                filetypes = { 'mips' },
                root_dir = lspconfig.util.root_pattern('*.s'),
                single_file_support = true,
                settings = {},
            };
        }

        -- indentation config
        local indentGroup = vim.api.nvim_create_augroup("MipsIndentation", { clear = true })
        vim.api.nvim_create_autocmd(
            { 'FileType' },
            {
                pattern = 'mips',
                command = 'setlocal shiftwidth=8 tabstop=8 noexpandtab',
                group = indentGroup
            }
        )
    end
}
