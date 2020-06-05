const Readable = require('stream').Readable;
const Path = require('path');
const Fs = require('fs');
const IMAGES = { jpg: 1, png: 1, gif: 1, svg: 1, jpeg: 1, heic: 1, heif: 1, webp: 1, tiff: 1, bmp: 1 };
const HEADERSIZE = 2000;
const MKDIR = { recursive: true };
const REGCLEAN = /^[\s]+|[\s]+$/g;
const BINARYREADDATA = { start: HEADERSIZE };
const BINARYREADDATABASE64 = { start: HEADERSIZE, encoding: 'base64' };
const BINARYREADMETA = { start: 0, end: HEADERSIZE - 1, encoding: 'binary' };

function FileDB(name, directory) {
	var t = this;
	t.name = name;
	t.directory = directory;
	t.logger = directory + '/files.log';
	t.cache = {};
	t.total = 0;
	t.size = 0;
	t.ext = '.file';
}

const FP = FileDB.prototype;

FP.service = function(counter) {
	if (counter % 10)
		this.cache = {};
};

FP.makedirectory = function(id) {

	var val = (HASH(id, true) % 10000) + '';
	var diff = 4 - val.length;

	if (diff > 0) {
		for (var i = 0; i < diff; i++)
			val = '0' + val;
	}

	if (diff.length > 4)
		val = val.substring(0, 4);

	return Path.join(this.directory, val);
};

FP.readfilename = function(id) {
	var self = this;
	var directory = self.makedirectory(id);
	return Path.join(directory, id + '.file');
};

FP.save = function(id, name, filename, callback) {

	var self = this;
	var directory = self.makedirectory(id);
	var filenameto = Path.join(directory, id + '.file');

	var index = name.lastIndexOf('/');
	if (index !== -1)
		name = name.substring(index + 1);

	if (self.cache[directory]) {
		self.saveforce(id, name, filename, filenameto, callback);
	} else {
		Fs.mkdir(directory, MKDIR, function(err) {
			if (err)
				callback(err);
			else {
				self.cache[directory] = 1;
				self.saveforce(id, name, filename, filenameto, callback);
			}
		});
	}

	return self;
};

FP.saveforce = function(id, name, filename, filenameto, callback, custom) {

	if (!callback)
		callback = NOOP;

	var isbuffer = filename instanceof Buffer;
	var self = this;
	var header = Buffer.alloc(HEADERSIZE, ' ');
	var reader = isbuffer ? null : filename instanceof Readable ? filename : Fs.createReadStream(filename);
	var writer = Fs.createWriteStream(filenameto);

	var ext = ext(name);
	var meta = { name: name, size: 0, width: 0, height: 0, ext: ext, custom: custom, type: U.getContentType(ext) };
	var tmp;

	writer.write(header, 'binary');

	if (IMAGES[meta.ext]) {
		reader.once('data', function(buffer) {
			switch (meta.ext) {
				case 'gif':
					tmp = framework_image.measureGIF(buffer);
					break;
				case 'png':
					tmp = framework_image.measurePNG(buffer);
					break;
				case 'jpg':
				case 'jpeg':
					tmp = framework_image.measureJPG(buffer);
					break;
				case 'svg':
					tmp = framework_image.measureSVG(buffer);
					break;
			}
		});
	}

	if (isbuffer)
		writer.end(filename);
	else
		reader.pipe(writer);

	CLEANUP(writer, function() {

		Fs.open(filenameto, 'r+', function(err, fd) {

			if (err) {
				// Unhandled error
				callback(err);
				return;
			}

			if (tmp) {
				meta.width = tmp.width;
				meta.height = tmp.height;
			}

			meta.size = writer.bytesWritten - HEADERSIZE;

			self.total++;
			self.size += meta.size;

			if (meta.name.length > 250)
				meta.name = meta.name.substring(0, 250);

			header.write(JSON.stringify(meta));

			// Update header
			Fs.write(fd, header, 0, header.length, 0, function(err) {
				if (err) {
					callback(err);
					Fs.close(fd, NOOP);
				} else {
					meta.id = id;
					meta.date = NOW = new Date();
					meta.type = 'save';
					Fs.appendFile(self.logger, JSON.stringify(meta) + '\n', NOOP);
					Fs.close(fd, () => callback(null, meta));
				}
			});
		});
	});
};

FP.read = function(id, callback, nostream) {

	var self = this;
	var filename = Path.join(self.makedirectory(id), id + '.file');

	Fs.open(filename, 'r', function(err, fd) {

		if (err) {
			callback(err);
			return;
		}

		var buffer = Buffer.alloc(HEADERSIZE);
		Fs.read(fd, buffer, 0, HEADERSIZE, 0, function(err) {

			if (err) {
				callback(err);
				Fs.close(fd, NOOP);
				return;
			}

			var meta = buffer.toString('utf8').replace(REGCLEAN, '').parseJSON();

			if (!nostream) {
				meta.stream = Fs.createReadStream(filename, { fd: fd, start: HEADERSIZE });
				CLEANUP(meta.stream, () => Fs.close(fd, NOOP));
			}

			callback(err, meta);
		});
	});

	return self;
};

FP.remove = function(id, callback) {
	var self = this;
	var filename = Path.join(self.makedirectory(id), id + '.file');
	Fs.unlink(filename, function(err) {
		!err && Fs.appendFile(self.logger, JSON.stringify({ type: 'remove', id: id, date: new Date() }) + '\n', NOOP);
		callback && callback(err);
	});
	return self;
};

FP.clear = function(callback) {

	var self = this;
	var count = 0;

	Fs.readdir(self.directory, function(err, response) {
		if (err)
			return callback(err);
		Fs.appendFile(self.logger, JSON.stringify({ type: 'clear', date: new Date() }) + '\n', NOOP);
		response.wait(function(item, next) {
			var dir = Path.join(self.directory, item);
			Fs.readdir(dir, function(err, response) {
				if (response instanceof Array) {
					count += response.length;
					response.wait((file, next) => Fs.unlink(Path.join(self.directory, item, file), next), () => Fs.rmdir(dir, next));
				} else
					next();
			});
		}, function() {
			self.cache = {};
			callback && callback(null, count);
		});

	});

	return self;
};

FP.browse = function(callback) {
	var self = this;
	Fs.readdir(self.directory, function(err, response) {
		var files = [];
		response.wait(function(item, next) {
			Fs.readdir(Path.join(self.directory, item), function(err, response) {
				if (response instanceof Array) {
					response.wait(function(item, next) {
						var id = item.substring(0, item.lastIndexOf('.'));
						self.read(id, function(err, meta) {
							if (meta) {
								meta.id = id;
								files.push(meta);
							}
							next();
						}, true);
					}, next);
				} else
					next();
			});
		}, () => callback(null, files));
	});
	return self;
};

FP.count = function(callback) {
	var self = this;
	var count = 0;
	Fs.readdir(self.directory, function(err, response) {
		response.wait(function(item, next) {
			Fs.readdir(Path.join(self.directory, item), function(err, response) {
				if (response instanceof Array)
					count += response.length;
				next();
			});
		}, () => callback(null, count));
	});
	return self;
};

function jsonparser(key, value) {
	return typeof(value) === 'string' && value.isJSONDate() ? new Date(value) : value;
}

FP.readmeta = function(id, callback, count) {

	var self = this;

	if (count > 3) {
		callback(new Error('File not found.'));
		return self;
	}

	var filename = Path.join(self.makedirectory(id), id + self.ext);

	var stream = Fs.createReadStream(filename, HEADERSIZE);
	stream.on('error', err => callback(err));
	stream.on('data', function(buffer) {
		var json = buffer.toString('utf8').replace(REGCLEAN, '');
		if (json) {
			callback(null, JSON.parse(json, jsonparser));
			CLEANUP(stream);
		} else
			setTimeout(readfileattempt, 100, self, id, callback, count || 1);
	});

	return self;
};

FP.res = function(res, options, checkcustom, notmodified) {

	var self = this;
	var req = res.req;

	if (RELEASE && req.$key && F.temporary.notfound[req.$key] !== undefined) {
		res.throw404();
		return res;
	}

	var id = options.id || '';
	var filename = Path.join(self.makedirectory(id), id + self.ext);

	var stream = Fs.createReadStream(filename, HEADERSIZE);

	stream.on('error', function() {
		if (RELEASE)
			F.temporary.notfound[F.createTemporaryKey(req)] = true;
		res.throw404();
	});

	stream.on('data', function(buffer) {
		var json = buffer.toString('utf8').replace(REGCLEAN, '');
		if (json) {

			var obj;

			try {
				obj = JSON.parse(json, jsonparser);
			} catch (e) {
				console.log('FileStorage Error:', filename, e);
				if (RELEASE)
					F.temporary.notfound[F.createTemporaryKey(req)] = true;
				res.throw404();
				return;
			}

			if (checkcustom && checkcustom(obj) == false) {
				if (RELEASE)
					F.temporary.notfound[F.createTemporaryKey(req)] = true;
				res.throw404();
				return;
			}

			var utc = obj.date ? new Date(+obj.date.substring(0, 4), +obj.date.substring(4, 6), +obj.date.substring(6, 8)).toUTCString() : '';

			if (!options.download && req.headers['if-modified-since'] === utc) {
				res.extention = ext(obj.name);
				notmodified(res, utc);
			} else {

				if (RELEASE && req.$key && F.temporary.path[req.$key]) {
					res.$file();
					return res;
				}

				res.options.type = obj.type;
				res.options.stream = Fs.createReadStream(filename, HEADERSIZE);
				res.options.lastmodified = true;

				if (options.download) {
					res.options.download = options.download === true ? obj.name : typeof(options.download) === 'function' ? options.download(obj.name, obj.type) : options.download;
				} else {
					!options.headers && (options.headers = {});
					options.headers['Last-Modified'] = utc;
				}

				res.options.headers = options.headers;
				res.options.done = options.done;

				if (options.image) {
					res.options.make = options.make;
					res.options.cache = options.cache !== false;
					res.$image();
				} else {
					res.options.compress = options.nocompress ? false : true;
					res.$stream();
				}
			}
		} else {
			if (RELEASE)
				F.temporary.notfound[F.createTemporaryKey(req)] = true;
			res.throw404();
		}
	});
};

FP.readbase64 = function(id, callback, count) {

	var self = this;

	if (count > 3) {
		callback(new Error('File not found.'));
		return self;
	}

	var filename = Path.join(self.makedirectory(id), id + self.ext);
	var stream = Fs.createReadStream(filename, HEADERSIZE);
	stream.on('error', err => callback(err));
	stream.on('data', function(buffer) {
		var json = buffer.toString('utf8').replace(REGCLEAN, '');
		if (json) {
			var meta = JSON.parse(json, jsonparser);
			stream = Fs.createReadStream(filename, BINARYREADDATABASE64);
			callback(null, stream, meta);
			CLEANUP(stream);
		} else
			setTimeout(readfileattempt, 100, self, id, callback, count || 1);
	});

	return self;
};

function readfileattempt(self, id, callback, count) {
	self.readmeta(id, callback, count + 1);
}

FP.drop = function(callback) {
	this.clear(callback);
};

function ext(name) {
	var index = name.lastIndexOf('.');
	return index === -1 ? '' : name.substring(index + 1).toLowerCase();
}

exports.FileDB = function(name, directory) {
	return new FileDB(name, directory);
};
