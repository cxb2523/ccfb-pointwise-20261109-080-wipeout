"use strict"

// ----------------------------------------------------------------------------
// Minimap: 2D top-down HUD view of the track spline.
//
// The closed HermiteCurve3 is pre-sampled once per track load (1024 points,
// ~8KB of Float32Arrays) together with tangents, bounding box and a uniform
// world->map projection. The track outline is pre-rendered to an offscreen
// canvas, so per-frame work is just a small windowed nearest-point search
// plus one drawImage and the ship arrow.

var Minimap = function(canvas, sampleCount) {
	this.canvas = canvas;
	this.ctx = canvas.getContext('2d');
	this.width = canvas.width;
	this.height = canvas.height;
	this.padding = 12;

	this.sampleCount = sampleCount || 1024;
	this.searchWindow = 48;         // +/- samples around the last known index
	this.coarseStride = 8;          // stride of the fallback full search
	this.lowSpeedThreshold = 500;   // world units/s; below this the arrow follows the tangent

	this.reset();
};

// Drop all cached track data. Called on scene clear and before rebuilding
// after a track (re)load or deformation.
Minimap.prototype.reset = function() {
	this.curve = null;
	this.pointsX = null;
	this.pointsZ = null;
	this.tangentX = null;
	this.tangentZ = null;
	this.sampleSpacing = 0;
	this.scale = 1;
	this.offsetX = 0;
	this.offsetY = 0;
	this.trackLayer = null;   // offscreen canvas with the pre-rendered outline
	this.lastIndex = -1;      // -1 = no lock on the curve
	this.lastAngle = 0;
	this.shipX = 0;
	this.shipZ = 0;
};

// Pre-sample the closed curve and build all caches.
Minimap.prototype.setTrack = function(curve) {
	this.reset();
	this.curve = curve;

	var n = this.sampleCount;
	var px = this.pointsX = new Float32Array(n);
	var pz = this.pointsZ = new Float32Array(n);

	var minX = Infinity, maxX = -Infinity;
	var minZ = Infinity, maxZ = -Infinity;

	for (var i = 0; i < n; i++) {
		var p = curve.getPoint(i / n);
		px[i] = p.x;
		pz[i] = p.z;
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.z < minZ) minZ = p.z;
		if (p.z > maxZ) maxZ = p.z;
	}

	// Tangents via central difference (wraparound) + average segment length
	var tx = this.tangentX = new Float32Array(n);
	var tz = this.tangentZ = new Float32Array(n);
	var totalLength = 0;
	for (i = 0; i < n; i++) {
		var prev = (i + n - 1) % n;
		var next = (i + 1) % n;
		var dx = px[next] - px[prev];
		var dz = pz[next] - pz[prev];
		var len = Math.sqrt(dx * dx + dz * dz) || 1;
		tx[i] = dx / len;
		tz[i] = dz / len;

		var sx = px[next] - px[i];
		var sz = pz[next] - pz[i];
		totalLength += Math.sqrt(sx * sx + sz * sz);
	}
	this.sampleSpacing = totalLength / n;

	// Uniform scale, centered in the canvas
	var spanX = Math.max(maxX - minX, 1);
	var spanZ = Math.max(maxZ - minZ, 1);
	var usable = Math.min(this.width, this.height) - this.padding * 2;
	this.scale = usable / Math.max(spanX, spanZ);
	this.offsetX = (this.width - spanX * this.scale) / 2 - minX * this.scale;
	this.offsetY = (this.height - spanZ * this.scale) / 2 - minZ * this.scale;

	// Pre-render the track outline once; each frame just blits this layer
	this.trackLayer = document.createElement('canvas');
	this.trackLayer.width = this.width;
	this.trackLayer.height = this.height;
	var ctx = this.trackLayer.getContext('2d');

	ctx.strokeStyle = 'rgba(65, 175, 255, 0.9)';
	ctx.lineWidth = 2;
	ctx.lineJoin = 'round';
	ctx.beginPath();
	for (i = 0; i <= n; i++) {
		var j = i % n;
		var mx = px[j] * this.scale + this.offsetX;
		var my = pz[j] * this.scale + this.offsetY;
		if (i === 0) {
			ctx.moveTo(mx, my);
		} else {
			ctx.lineTo(mx, my);
		}
	}
	ctx.stroke();

	// Start/finish marker at t = 0
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(
		px[0] * this.scale + this.offsetX - 2,
		pz[0] * this.scale + this.offsetY - 2,
		4, 4
	);
};

// Locate the ship on the curve and update the arrow heading.
// position/velocity: anything with .x/.z (velocity in world units/s).
Minimap.prototype.update = function(position, velocity) {
	if (!this.curve) {
		return;
	}

	var n = this.sampleCount;
	var px = this.pointsX, pz = this.pointsZ;
	var x = position.x, z = position.z;
	var speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);

	var index = -1;
	var bestDist = Infinity;
	var i, d, dx, dz, dist;

	if (this.lastIndex >= 0) {
		// Windowed search around the last known index; the modulo handles
		// the wraparound across the start/finish line.
		var w = this.searchWindow;
		for (d = -w; d <= w; d++) {
			i = (this.lastIndex + d + n) % n;
			dx = px[i] - x;
			dz = pz[i] - z;
			dist = dx * dx + dz * dz;
			if (dist < bestDist) {
				bestDist = dist;
				index = i;
			}
		}

		// Confidence check: a jump/respawn teleports the ship far from the
		// last lock, and a candidate whose tangent opposes the velocity is
		// likely a stale lock on a parallel section. Only then fall back.
		var confident = bestDist < this.sampleSpacing * this.sampleSpacing * 16;
		if (confident && speed > this.lowSpeedThreshold) {
			var dot = velocity.x * this.tangentX[index] + velocity.z * this.tangentZ[index];
			if (dot < 0) {
				confident = false;
			}
		}

		if (!confident) {
			index = -1;
		}
	}

	if (index < 0) {
		// Coarse full search + local refine. Runs only while the lock is
		// lost, never per frame.
		bestDist = Infinity;
		for (i = 0; i < n; i += this.coarseStride) {
			dx = px[i] - x;
			dz = pz[i] - z;
			dist = dx * dx + dz * dz;
			if (dist < bestDist) {
				bestDist = dist;
				index = i;
			}
		}
		var coarse = index;
		for (d = -this.coarseStride; d <= this.coarseStride; d++) {
			i = (coarse + d + n) % n;
			dx = px[i] - x;
			dz = pz[i] - z;
			dist = dx * dx + dz * dz;
			if (dist < bestDist) {
				bestDist = dist;
				index = i;
			}
		}
	}

	this.lastIndex = index;
	this.shipX = x;
	this.shipZ = z;

	// Arrow heading: tangent at low speed (stable while hovering or right
	// after a respawn), horizontal velocity at speed (matches the actual
	// heading, so the arrow doesn't flail during jumps).
	if (speed > this.lowSpeedThreshold) {
		this.lastAngle = Math.atan2(velocity.z, velocity.x);
	} else {
		this.lastAngle = Math.atan2(this.tangentZ[index], this.tangentX[index]);
	}
};

Minimap.prototype.render = function() {
	var ctx = this.ctx;
	ctx.clearRect(0, 0, this.width, this.height);

	if (!this.trackLayer || this.lastIndex < 0) {
		return;
	}

	ctx.drawImage(this.trackLayer, 0, 0);

	// Ship arrow at the actual (projected) ship position
	var sx = this.shipX * this.scale + this.offsetX;
	var sy = this.shipZ * this.scale + this.offsetY;

	ctx.save();
	ctx.translate(sx, sy);
	ctx.rotate(this.lastAngle);
	ctx.fillStyle = '#ffff00';
	ctx.beginPath();
	ctx.moveTo(7, 0);
	ctx.lineTo(-5, 4);
	ctx.lineTo(-2, 0);
	ctx.lineTo(-5, -4);
	ctx.closePath();
	ctx.fill();
	ctx.restore();
};
