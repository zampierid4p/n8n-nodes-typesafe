const path = require('path');
const { task, src, dest } = require('gulp');

task('build:icons', copyIcons);

/** Resolves once a vinyl stream has finished writing. */
function finished(stream) {
	return new Promise((resolve, reject) => {
		stream.on('finish', resolve).on('end', resolve).on('error', reject);
	});
}

function copyIcons() {
	const nodes = src(path.resolve('nodes', '**', '*.{png,svg,json}'), { encoding: false }).pipe(
		dest(path.resolve('dist', 'nodes')),
	);

	const credentials = src(path.resolve('credentials', '**', '*.{png,svg,json}'), {
		encoding: false,
		allowEmpty: true,
	}).pipe(dest(path.resolve('dist', 'credentials')));

	// Both streams must be awaited: returning only one lets gulp report the task
	// as done while the other is still copying, which left dist/ without icons.
	return Promise.all([finished(nodes), finished(credentials)]);
}
