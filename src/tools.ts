// astexplorer: https://astexplorer.net/
// babel-core doc: https://babeljs.io/docs/en/babel-core

import {
	traverse,
	NodePath,
	transformFromAstAsync as babel_transformFromAstAsync,
	types as t,
} from '@babel/core';

import {
	parse as babel_parse
} from '@babel/parser';


import {
	codeFrameColumns,
} from '@babel/code-frame';

// @ts-ignore (Could not find a declaration file for module '@babel/plugin-transform-modules-commonjs')
import babelPluginTransformModulesCommonjs from '@babel/plugin-transform-modules-commonjs'


// @ts-ignore (TS7016: Could not find a declaration file for module 'spark-md5')
import SparkMD5 from 'spark-md5'


import { Cache, ValueFactory, Options, LoadModule, ModuleExport } from './common.d.ts'


/**
 * @internal
 */
const genSourcemap : boolean = !!process.env.GEN_SOURCEMAP;

const version : string = process.env.VERSION;


// tools


/**
 * @internal
 */
export function formatError(message : string, path : string, source : string, line : number, column : number) : string {

	const location = {
		start: { line, column },
	};

	return '\n' + path + '\n' + codeFrameColumns(source, location, {
		message,
	}) + '\n';
}


/**
 * @internal
 */
export function hash(...valueList : any[]) : string {

	const hashInstance = new SparkMD5();
	for ( const val of valueList )
		hashInstance.append( typeof val === 'string' ? val : JSON.stringify(val) );
	return hashInstance.end().slice(0, 8);
}



/**
 * Simple cache helper
 * preventCache usage: non-fatal error
 * @internal
 */
export async function withCache( cacheInstance : Cache, key : any[], valueFactory : ValueFactory ) {

	let cachePrevented = false;

	const api = {
		preventCache: () => cachePrevented = true,
	}

	if ( !cacheInstance )
		return await valueFactory(api);

	const hashedKey = hash(...key);
	const valueStr = await cacheInstance.get(hashedKey);
	if ( valueStr )
		return JSON.parse(valueStr);

	const value = await valueFactory(api);

	if ( !cachePrevented )
		await cacheInstance.set(hashedKey, JSON.stringify(value));

	return value;
}


/**
 * @internal
 */
export function interopRequireDefault(obj : any) : any {

  return obj && obj.__esModule ? obj : { default: obj };
}

// node types: https://babeljs.io/docs/en/babel-types
// handbook: https://github.com/jamiebuilds/babel-handbook/blob/master/translations/en/plugin-handbook.md

/**
 * import is a reserved keyword, then rename
 * @internal
 */
export function renameDynamicImport(fileAst : t.File) : void {

	traverse(fileAst, {
		CallExpression(path : NodePath<t.CallExpression>) {

			if ( t.isImport(path.node.callee) )
				path.replaceWith(t.callExpression(t.identifier('import_'), path.node.arguments))
		}
	});
}


/**
 * @internal
 */
export function parseDeps(fileAst : t.File) : string[] {

	const requireList : string[] = [];

	traverse(fileAst, {
		ImportDeclaration(path : NodePath<t.ImportDeclaration>) {

			requireList.push(path.node.source.value);
		},
		CallExpression(path : NodePath<t.CallExpression>) {

			if (
				   // @ts-ignore (Property 'name' does not exist on type 'ArrayExpression')
				   path.node.callee.name === 'require'
				&& path.node.arguments.length === 1
				&& t.isStringLiteral(path.node.arguments[0])
			) {

				requireList.push(path.node.arguments[0].value)
			}
		}
	});

	return requireList;
}


/**
 * @internal
 */
export async function transformJSCode(source : string, moduleSourceType : boolean, filename : string, options : Options) {

	const { additionalBabelPlugins = [], log } = options;

	let ast;
	try {

		ast = babel_parse(source, {
			// doc: https://babeljs.io/docs/en/babel-parser#options
			sourceType: moduleSourceType ? 'module' : 'script',
			sourceFilename: filename,
		});
	} catch(ex) {

		log?.('error', 'parse script', formatError(ex.message, filename, source, ex.loc.line, ex.loc.column + 1) );
		throw ex;
	}

	renameDynamicImport(ast);
	const depsList = parseDeps(ast);

	const transformedScript = await babel_transformFromAstAsync(ast, source, {
		sourceMaps: genSourcemap, // doc: https://babeljs.io/docs/en/options#sourcemaps
		plugins: [ // https://babeljs.io/docs/en/options#plugins
			babelPluginTransformModulesCommonjs, // https://babeljs.io/docs/en/babel-plugin-transform-modules-commonjs#options
			...additionalBabelPlugins
		],
		babelrc: false,
		configFile: false,
		highlightCode: false,
	});

	return [ depsList, transformedScript.code ];
}



// module tools

/**
 * Create a cjs module
 * @internal
 */
export function createModule(filename : string, source : string, options : Options, loadModule : LoadModule) {

	const { moduleCache, pathHandlers: { resolve } } = options;

	const require = function(path : string) {

		const absPath = resolve(filename, path);
		if ( absPath in moduleCache )
			return moduleCache[absPath];

		throw new Error(`${ absPath } not found in moduleCache`);
	}

	const import_ = async function(path : string) {

		return await loadModule(resolve(filename, path), options);
	}

	const module = {
		exports: {}
	}

	// see https://github.com/nodejs/node/blob/a46b21f556a83e43965897088778ddc7d46019ae/lib/internal/modules/cjs/loader.js#L195-L198
	// see https://github.com/nodejs/node/blob/a46b21f556a83e43965897088778ddc7d46019ae/lib/internal/modules/cjs/loader.js#L1102
	Function('exports', 'require', 'module', '__filename', '__dirname', 'import_', source).call(module.exports, module.exports, require, module, filename, resolve(filename, '.'), import_);

	return module;
}


/**
 * @internal
 */
export async function createJSModule(source : string, moduleSourceType : boolean, filename : string, options : Options, loadModule : LoadModule) {

	const { compiledCache } = options;

	const [ depsList, transformedSource ] = await withCache(compiledCache, [ version, source, filename ], async () => {

		return await transformJSCode(source, moduleSourceType, filename, options);
	});

	await loadDeps(filename, depsList, options, loadModule);
	return createModule(filename, transformedSource, options, loadModule).exports;
}


/**
 * Just load and cache given dependencies.
 * @internal
 */
export async function loadDeps(filename : string, deps : string[], options : Options, loadModule : LoadModule) {

	const { pathHandlers: { resolve } } = options;
	await Promise.all(deps.map(dep => loadModule(resolve(filename, dep), options)))
}

