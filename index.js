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

Promise.config({
  // Enable warnings
  warnings: true,
  // Enable long stack traces
  longStackTraces: true,
  // Enable cancellation
  cancellation: true,
  // Enable monitoring
  monitoring: true
});


loadAll(process.cwd())
  .catch(function(err) {
    console.log(err.stack);
  })
  .finally(function() {
    return rmdir(tmpDir);
  });

// Function definitions below

function loadAll(dir) {
  //console.log('Load all -> ', dir);
  var deps = findDependencies(dir);
  return Promise.map(deps, function(dep) {
    return loadSingle(dir, dep.name, dep.version);
  }, {
    concurrency: 1
  });
}

function loadSingle(dir, name, version) {
  //console.log('Load single -> ', [name, version], ' to ', dir);
  return localVersionExists(dir, name)
    .then(function(exists) {
      return exists && localVersionSatisfies(dir, name, version);
    })
    .then(function(localVersionSatisifes) {
      if (localVersionSatisifes) {
        return; // Nothing more to do
      } else {
        return removeLocalVersion(dir, name)
          .then(function() {
            return loadDependency(dir, name, version);
          });
      }
    })
    .then(function() {
      // Load all of this module's dependencies recursively
      return loadAll(path.resolve(dir, 'node_modules', name));
    })
}

function findDependencies(dir) {
  var packageJson = path.resolve(dir, 'package.json');
  var deps = require(packageJson).dependencies || [];
  return Object.keys(deps).map(function(dep) {
    return {
      name: dep,
      version: deps[dep]
    };
  });
}

function loadDependency(dir, name, version) {
  return getCacheDepPath(name, version)
    .then(function(dir) {
      return dir || loadMissingDepenency(name, version)
    })
    .then(function(dir) {
      var src = path.resolve(dir, 'package.tgz');
      var dest = path.resolve(tmpDir, 'packages', name);
      return tarball.extractTarballAsync(src, dest)
        .then(function() {
          return dest;
        });
    })
    .then(function(package) {
      var src = path.resolve(package, 'package');
      var dest = path.resolve(dir, 'node_modules', name);
      return mv(src, dest, {
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

function loadMissingDepenency(name, version) {
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