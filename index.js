#! /usr/bin/env node

var isThere = require('is-there');
var Promise = require('bluebird');
var semver = require('semver');
var oshome = require('os-homedir');
var tarball = Promise.promisifyAll(require('tarball-extract'));
var npmi = Promise.promisify(require('npmi'));
var rmdir = Promise.promisify(require('rmdir'));
var mkdirp = Promise.promisify(require('mkdirp'));
var mv = Promise.promisify(require('mv'));

var fs = Promise.promisifyAll(require('fs'));
var os = require('os');
var path = require('path');

var cacheDir = path.resolve(oshome(), '.npm');
var tmpDir = path.resolve(os.tmpdir(), 'cachepm');

var verbose = true; // TODO Read from arguments using minimist maybe

// TODO: This always has to fetch URL dependencies. Maybe we can improve upon
//  that if they provide a tag/commitish?
// TODO: Also sometimes fails for dependencies with ~ in the versions?

var log = (function() {
  var indentString = '--';
  var currentIndent = '';
  var log = function() {
    if (verbose) {
      var args = Array.prototype.slice.call(arguments);
      var msg = [currentIndent].concat(args);
      console.log.apply(console, msg);
    }
  }
  log.indent = function() {
    currentIndent += indentString;
  }
  log.unindent = function() {
    currentIndent = currentIndent.substring(0, currentIndent.length - indentString.length);
  }
  return log;
})();

Promise.config({
  warnings: true,
  longStackTraces: true,
  cancellation: true,
  monitoring: true
});


loadAll(process.cwd())
  .catch(function(err) {
    console.error(err.stack);
  })
  .finally(function() {
    return rmdir(tmpDir);
  });

// Function definitions below

function loadAll(dir) {
  log('Load all -> ', dir);
  log.indent();
  var deps = findDependencies(dir);
  return Promise.map(deps, function(dep) {
    return loadSingle(dir, dep.name, dep.version)
      .then(function() {
        // Load all of this module's dependencies recursively
        var depDir = path.resolve(dir, 'node_modules', dep.name);
        return loadAll(depDir);
      });
  }, {
    concurrency: 1
  })
  .then(log.unindent);
}

function loadSingle(dir, name, version) {
  log('Load single -> ', [name, version], ' to ', dir);
  log.indent();
  return localVersionExists(dir, name)
    .then(function(exists) {
      return exists && localVersionSatisfies(dir, name, version);
    })
    .then(function(localVersionSatisifes) {
      if (localVersionSatisifes) {
        log('Local version good enough, moving on');
        return; // Nothing more to do
      } else {
        log('Local version not up to date or non-existant, removing it and getting a fresh copy');
        return removeLocalVersion(dir, name)
          .then(function() {
            return loadDependency(dir, name, version);
          });
      }
    })
    .then(log.unindent);
}

function findDependencies(dir) {
  var packageJson = path.resolve(dir, 'package.json');
  var mod = require(packageJson);

  return getDeps(mod.dependencies).concat(getDeps(mod.devDependencies));

  function getDeps(depsObj) {
    depsObj = depsObj || {};
    return Object.keys(depsObj).map(function(dep) {
      return {
        name: dep,
        version: depsObj[dep]
      };
    });
  }
}

function loadDependency(dir, name, version) {

  // Dependencies whose versions are URLs are never cached, so we can't do any
  //  optimizations with these.
  if (isDepVersionUrl(version)) {
    log('Loading ', name, ' directly from URL to: ', dir);
    return loadDepfromUrl(dir, name, version);
  }

  // Else we can utilize the NPM cache
  return getCacheDepPath(name, version)
    .then(function(cacheDir) {
      return cacheDir || loadMissingDepenency(name, version)
    })
    .then(function(cacheDir) {
      log('Cached directory: ', cacheDir);
      var src = path.resolve(cacheDir, 'package.tgz');
      var dest = path.resolve(tmpDir, 'packages', name);
      log('Loading cached version at: ', src);
      return tarball.extractTarballAsync(src, dest)
        .then(function() {
          // We should only have on extracted folder in the dest directory now.
          // (No real guarantees on the name, however.)
          return getOnlySubDirectory(dest);
        });
    })
    .then(function(packageDir) {
      var dest = path.resolve(dir, 'node_modules', name);
      return mv(packageDir, dest, {
        mkdirp: true,
        clobber: true
      });
    });
}

function localVersionExists(dir, name) {
  var location = path.resolve(dir, 'node_modules', name);
  return Promise.resolve(isThere(location));
}

function localVersionSatisfies(dir, name, requiredVersion) {
  var location = path.resolve(dir, 'node_modules', name, 'package.json');
  var localVersion = require(location).version;
  var satisfies = semver.satisfies(localVersion, requiredVersion);
  return Promise.resolve(satisfies);
}

function removeLocalVersion(dir, name) {
  return localVersionExists(dir, name)
    .then(function(exists) {
      if (exists) {
        var location = path.resolve(dir, 'node_modules', name);
        return rmdir(location);
      } else {
        return true;
      }
    });
}

function loadMissingDepenency(dir, name, version) {
  log('Downloading ', [name, version], ' from NPM');
  // Load it with npm, which will put it in the npm cache.
  // We'll just delete the one that was installed, and use the cached one now.
  return npmi({
      name: name,
      version: version,
      path: path.resolve(tmpDir, 'download')
    })
    .then(function() {
      return getCacheDepPath(name, version);
    })
}

function isDepVersionUrl(version) {
  // Probably a better way to do this, but it also covers USER/REPO format
  return version.indexOf('/') > -1;
}

function loadDepfromUrl(dir, name, version) {
  return npmi({
    name: name,
    version: version,
    path: dir
  });
}

function getCacheDepPath(name, version) {
  // Assumes that cacheDir exists
  var dir = path.resolve(cacheDir, name);
  if (!isThere(dir)) {
    return Promise.resolve(null);
  }

  return listDirectories(dir).then(function(dirs) {

    // Each directory name will be a version number
    var versions = dirs.reduce(function(mapping, dir) {
      var version = getDirectoryName(dir);
      mapping[version] = dir;
      return mapping;
    }, {});

    var maxVersion = semver.maxSatisfying(Object.keys(versions), version);

    if (!maxVersion) {
      return null
    }

    return versions[maxVersion];
  });
}

function getOnlySubDirectory(dir) {
  return listDirectories(dir)
    .then(function(dirs) {
      return dirs[0];
    });
}

function listDirectories(dir) {
  return fs.readdirAsync(dir)
    .filter(function(file) {
      return fs.statAsync(path.resolve(dir, file))
        .then(function(stat) {
          return stat.isDirectory();
        });
    })
    .map(function(versionName) {
      return path.resolve(dir, versionName);
    });
}

function getDirectoryName(dir) {
  return dir.split(path.sep).slice(-1);
}
