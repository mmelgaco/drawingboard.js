window.DrawingBoard = typeof DrawingBoard !== "undefined" ? DrawingBoard : {};

/**
 * pass the id of the html element to put the drawing board into
 * and some options : {
 *	controls: array of controls to initialize with the drawingboard. 'Colors', 'Size', and 'Navigation' by default
 *		instead of simple strings, you can pass an object to define a control opts
 *		ie ['Color', { Navigation: { reset: false }}]
 *	controlsPosition: "top left" by default. Define where to put the controls: at the "top" or "bottom" of the canvas, aligned to "left"/"right"/"center"
 *	background: background of the drawing board. Give a hex color or an image url "#ffffff" (white) by default
 *	color: pencil color ("#000000" by default)
 *	size: pencil size (3 by default)
 *	webStorage: 'session', 'local' or false ('session' by default). store the current drawing in session or local storage and restore it when you come back
 *	droppable: true or false (false by default). If true, dropping an image on the canvas will include it and allow you to draw on it,
 *	errorMessage: html string to put in the board's element on browsers that don't support canvas.
 * }
 */
DrawingBoard.Board = function(id, opts) {
	this.opts = this.mergeOptions(opts);

	this.ev = new DrawingBoard.Utils.MicroEvent();

	this.id = id;
	this.$el = $(document.getElementById(id));
	if (!this.$el.length)
		return false;

	var tpl = '<div class="drawing-board-canvas-wrapper"></canvas><canvas class="drawing-board-canvas"></canvas><canvas id="canvas2" class="drawing-board-canvas"><div class="drawing-board-cursor drawing-board-utils-hidden"></div></div>';
	if (this.opts.controlsPosition.indexOf("bottom") > -1) tpl += '<div class="drawing-board-controls"></div>';
	else tpl = '<div class="drawing-board-controls"></div>' + tpl;

	this.$el.addClass('drawing-board').append(tpl);
	this.dom = {
		$canvasWrapper: this.$el.find('.drawing-board-canvas-wrapper'),
		$canvas: this.$el.find('.drawing-board-canvas'),
        $canvas2: this.$el.find('#canvas2'),
		$cursor: this.$el.find('.drawing-board-cursor'),
		$controls: this.$el.find('.drawing-board-controls')
	};

	$.each(['left', 'right', 'center'], $.proxy(function(n, val) {
		if (this.opts.controlsPosition.indexOf(val) > -1) {
			this.dom.$controls.attr('data-align', val);
			return false;
		}
	}, this));

	this.canvas = this.dom.$canvas.get(0);
	this.ctx = this.canvas && this.canvas.getContext && this.canvas.getContext('2d') ? this.canvas.getContext('2d') : null;
	this.color = this.opts.color;

    this.canvas2 = this.dom.$canvas2.get(0);
    this.ctx2 = this.canvas2 && this.canvas2.getContext && this.canvas2.getContext('2d') ? this.canvas2.getContext('2d') : null;
    this.startX;
    this.startY;
    this.isDown = false;

    this.initStage();

	if (!this.ctx) {
		if (this.opts.errorMessage)
			this.$el.html(this.opts.errorMessage);
		return false;
	}

	this.storage = this._getStorage();

	this.initHistory();
	//init default board values before controls are added (mostly pencil color and size)
	this.reset({ webStorage: false, history: false, background: false });
	//init controls (they will need the default board values to work like pencil color and size)
	this.initControls();
	//set board's size after the controls div is added
	this.resize();
	//reset the board to take all resized space
	this.reset({ webStorage: false, history: true, background: true });
	this.restoreWebStorage();
	this.initDropEvents();
	this.initDrawEvents();
};



DrawingBoard.Board.defaultOpts = {
	controls: ['Color', 'DrawingMode', 'Size', 'Navigation'],
	controlsPosition: "top left",
	color: "#000000",
	size: 1,
	background: "#fff",
	eraserColor: "background",
	fillTolerance: 100,
    fillHack: true, //try to prevent issues with anti-aliasing with a little hack by default
	webStorage: 'session',
	droppable: false,
	enlargeYourContainer: false,
	errorMessage: "<p>It seems you use an obsolete browser. <a href=\"http://browsehappy.com/\" target=\"_blank\">Update it</a> to start drawing.</p>"
};



DrawingBoard.Board.prototype = {

    initStage: function(){
        this.stage = new createjs.Stage(this.canvas);
        this.stage.autoClear = false;
        this.shape=null;
        this.stage2 = new createjs.Stage(this.canvas2);
        this.stage2.autoClear = true;
        this.shape2=null;
    },

	mergeOptions: function(opts) {
		opts = $.extend({}, DrawingBoard.Board.defaultOpts, opts);
		if (!opts.background && opts.eraserColor === "background")
			opts.eraserColor = "transparent";
		return opts;
	},

	/**
	 * Canvas reset/resize methods: put back the canvas to its default values
	 *
	 * depending on options, can set color, size, background back to default values
	 * and store the reseted canvas in webstorage and history queue
	 *
	 * resize values depend on the `enlargeYourContainer` option
	 */

	reset: function(opts,silent) {
        silent = silent || false;
		opts = $.extend({
			color: this.opts.color,
			size: this.opts.size,
			webStorage: true,
			history: true,
			background: false
		}, opts);

        this.initStage();

		this.setMode('pencil', silent);

		if (opts.background) this.resetBackground(this.opts.background, false, silent);

		if (opts.color) this.setColor(opts.color);
		if (opts.size) this.ctx.lineWidth = opts.size;

		this.ctx.lineCap = "round";
		this.ctx.lineJoin = "round";
		// this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.width);

		if (opts.webStorage) this.saveWebStorage();

		if (opts.history) this.saveHistory();

		this.blankCanvas = this.getImg();

        if(!silent) this.ev.trigger('board:reset', opts);
	},

	resetBackground: function(background, historize, silent) {
		background = background || this.opts.background;
		historize = typeof historize !== "undefined" ? historize : true;
		var bgIsColor = DrawingBoard.Utils.isColor(background);
		var prevMode = this.getMode();
		this.setMode('pencil', silent);
		this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.width);
		if (bgIsColor) {
			this.ctx.fillStyle = background;
			this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
		} else if (background)
			this.setImg(background);
		this.setMode(prevMode, silent);
		if (historize) this.saveHistory();
	},

	resize: function() {
		this.dom.$controls.toggleClass('drawing-board-controls-hidden', (!this.controls || !this.controls.length));

		var canvasWidth, canvasHeight;
		var widths = [
			this.$el.width(),
			DrawingBoard.Utils.boxBorderWidth(this.$el),
			DrawingBoard.Utils.boxBorderWidth(this.dom.$canvasWrapper, true, true)
		];
		var heights = [
			this.$el.height(),
			DrawingBoard.Utils.boxBorderHeight(this.$el),
			this.dom.$controls.height(),
			DrawingBoard.Utils.boxBorderHeight(this.dom.$controls, false, true),
			DrawingBoard.Utils.boxBorderHeight(this.dom.$canvasWrapper, true, true)
		];
		var that = this;
		var sum = function(values, multiplier) { //make the sum of all array values
			multiplier = multiplier || 1;
			var res = values[0];
			for (var i = 1; i < values.length; i++) {
				res = res + (values[i]*multiplier);
			}
			return res;
		};
		var sub = function(values) { return sum(values, -1); }; //substract all array values from the first one

		if (this.opts.enlargeYourContainer) {
			canvasWidth = this.$el.width();
			canvasHeight = this.$el.height();

			this.$el.width( sum(widths) );
			this.$el.height( sum(heights) );
		} else {
			canvasWidth = sub(widths);
			canvasHeight = sub(heights);
		}

		this.dom.$canvasWrapper.css('width', canvasWidth + 'px');
		this.dom.$canvasWrapper.css('height', canvasHeight + 'px');

		this.dom.$canvas.css('width', canvasWidth + 'px');
		this.dom.$canvas.css('height', canvasHeight + 'px');

		this.canvas.width = canvasWidth;
		this.canvas.height = canvasHeight;

        this.dom.$canvas2.css('width', canvasWidth + 'px');
        this.dom.$canvas2.css('height', canvasHeight + 'px');

        this.canvas2.width = canvasWidth;
        this.canvas2.height = canvasHeight;
	},



	/**
	 * Controls:
	 * the drawing board can has various UI elements to control it.
	 * one control is represented by a class in the namespace DrawingBoard.Control
	 * it must have a $el property (jQuery object), representing the html element to append on the drawing board at initialization.
	 *
	 */

	initControls: function() {
		this.controls = [];
		if (!this.opts.controls.length || !DrawingBoard.Control) return false;
		for (var i = 0; i < this.opts.controls.length; i++) {
			var c = null;
			if (typeof this.opts.controls[i] == "string")
				c = new window['DrawingBoard']['Control'][this.opts.controls[i]](this);
			else if (typeof this.opts.controls[i] == "object") {
				for (var controlName in this.opts.controls[i]) break;
				c = new window['DrawingBoard']['Control'][controlName](this, this.opts.controls[i][controlName]);
			}
			if (c) {
				this.addControl(c);
			}
		}
	},

	//add a new control or an existing one at the position you want in the UI
	//to add a totally new control, you can pass a string with the js class as 1st parameter and control options as 2nd ie "addControl('Navigation', { reset: false }"
	//the last parameter (2nd or 3rd depending on the situation) is always the position you want to place the control at
	addControl: function(control, optsOrPos, pos) {
		if (typeof control !== "string" && (typeof control !== "object" || !control instanceof DrawingBoard.Control))
			return false;

		var opts = typeof optsOrPos == "object" ? optsOrPos : {};
		pos = pos ? pos*1 : (typeof optsOrPos == "number" ? optsOrPos : null);

		if (typeof control == "string")
			control = new window['DrawingBoard']['Control'][control](this, opts);

		if (pos)
			this.dom.$controls.children().eq(pos).before(control.$el);
		else
			this.dom.$controls.append(control.$el);

		if (!this.controls)
			this.controls = [];
		this.controls.push(control);
		this.dom.$controls.removeClass('drawing-board-controls-hidden');
	},



	/**
	 * History methods: undo and redo drawed lines
	 */

	initHistory: function() {
		this.history = {
			values: [],
			position: 0
		};
	},

	saveHistory: function () {
		while (this.history.values.length > 30) {
			this.history.values.shift();
			this.history.position--;
		}
		if (this.history.position !== 0 && this.history.position < this.history.values.length) {
			this.history.values = this.history.values.slice(0, this.history.position);
			this.history.position++;
		} else {
			this.history.position = this.history.values.length+1;
		}
		this.history.values.push(this.getImg());
		this.ev.trigger('savehistory', this.history.position);
	},

	_goThroughHistory: function(goForth) {
		if ((goForth && this.history.position == this.history.values.length) ||
			(!goForth && this.history.position == 1))
			return;
		var pos = goForth ? this.history.position+1 : this.history.position-1;
		if (this.history.values.length && this.history.values[pos-1] !== undefined) {
			this.history.position = pos;
			this.setImg(this.history.values[pos-1]);
		}
		this.ev.trigger('historyNavigation', pos);
		this.saveWebStorage();
	},

    goToHistoryPosition: function(pos){
        this.history.position = pos;
        this.setImg(this.history.values[pos-1]);
    },

	goBackInHistory: function() {
		this._goThroughHistory(false);
	},

	goForthInHistory: function() {
		this._goThroughHistory(true);
	},



	/**
	 * Image methods: you can directly put an image on the canvas, get it in base64 data url or start a download
	 */

    setImg: function(src, resize) {
        var ctx = this.ctx;
        var img = new Image();
        img.src = "";
        var oldGCO = ctx.globalCompositeOperation;
        var obj = this;
        img.addEventListener("load", function() {
            ctx.globalCompositeOperation = "source-over";
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.width);
            if(resize) {
                ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
            }else{
                ctx.drawImage(img, 0, 0);
            }
            ctx.globalCompositeOperation = oldGCO;

            //save the image in the history
            obj.saveWebStorage();
            obj.saveHistory();
        }, false);
        if(src.indexOf('base64')==-1) {
            img.crossOrigin = 'Anonymous';
        }
        img.src = src;
        this.initStage();
    },

	getImg: function() {
		return this.canvas.toDataURL("image/png");
	},

	downloadImg: function() {
		var img = this.getImg();
		img = img.replace("image/png", "image/octet-stream");
		window.location.href = img;
	},



	/**
	 * WebStorage handling : save and restore to local or session storage
	 */

	saveWebStorage: function() {
		if (window[this.storage]) {
			window[this.storage].setItem('drawing-board-' + this.id, this.getImg());
			this.ev.trigger('board:save' + this.storage.charAt(0).toUpperCase() + this.storage.slice(1), this.getImg());
		}
	},

	restoreWebStorage: function() {
		if (window[this.storage] && window[this.storage].getItem('drawing-board-' + this.id) !== null) {
			this.setImg(window[this.storage].getItem('drawing-board-' + this.id));
			this.ev.trigger('board:restore' + this.storage.charAt(0).toUpperCase() + this.storage.slice(1), window[this.storage].getItem('drawing-board-' + this.id));
		}
	},

	clearWebStorage: function() {
		if (window[this.storage] && window[this.storage].getItem('drawing-board-' + this.id) !== null) {
			window[this.storage].removeItem('drawing-board-' + this.id);
			this.ev.trigger('board:clear' + this.storage.charAt(0).toUpperCase() + this.storage.slice(1));
		}
	},

	_getStorage: function() {
		if (!this.opts.webStorage || !(this.opts.webStorage === 'session' || this.opts.webStorage === 'local')) return false;
		return this.opts.webStorage + 'Storage';
	},



	/**
	 * Drop an image on the canvas to draw on it
	 */

	initDropEvents: function() {
		if (!this.opts.droppable)
			return false;

		this.dom.$canvas.on('dragover dragenter drop', function(e) {
			e.stopPropagation();
			e.preventDefault();
		});

		this.dom.$canvas.on('drop', $.proxy(this._onCanvasDrop, this));
	},

	_onCanvasDrop: function(e) {
		e = e.originalEvent ? e.originalEvent : e;
		var files = e.dataTransfer.files;
		if (!files || !files.length || files[0].type.indexOf('image') == -1 || !window.FileReader)
			return false;
		var fr = new FileReader();
		fr.readAsDataURL(files[0]);
		fr.onload = $.proxy(function(ev) {
			this.setImg(ev.target.result);
			this.ev.trigger('board:imageDropped', ev.target.result);
			this.ev.trigger('board:userAction');
			this.saveHistory();
		}, this);
	},



	/**
	 * set and get current drawing mode
	 *
	 * possible modes are "pencil" (draw normally), "eraser" (draw transparent, like, erase, you know), "filler" (paint can)
	 */

	setMode: function(newMode, silent) {
		silent = silent || false;
		newMode = newMode || 'pencil';

        this.ev.unbind('board:startDrawing', $.proxy(this.text, this));
		this.ev.unbind('board:startDrawing', $.proxy(this.fill, this));

		if (this.opts.eraserColor === "transparent")
			this.ctx.globalCompositeOperation = newMode === "eraser" ? "destination-out" : "source-over";
		else {
			if (newMode === "eraser") {
				if (this.opts.eraserColor === "background" && DrawingBoard.Utils.isColor(this.opts.background))
					this.ctx.strokeStyle = this.opts.background;
				else if (DrawingBoard.Utils.isColor(this.opts.eraserColor))
					this.ctx.strokeStyle = this.opts.eraserColor;
			} else if (!this.mode || this.mode === "eraser") {
				this.ctx.strokeStyle = this.color;
			}

			if (newMode === "filler")
				this.ev.bind('board:startDrawing', $.proxy(this.fill, this));

            if (newMode === "text") {
                this.ev.bind('board:startDrawing', $.proxy(this.text, this));
                this.setSize(14);//default size for text
            }
		}
		this.mode = newMode;
		if (!silent)
			this.ev.trigger('board:mode', this.mode);
	},

	getMode: function() {
		return this.mode || "pencil";
	},

    setSize: function(size,silent){
        silent = silent || false;
        this.ctx.lineWidth = size;
        this.dom.$controls.find('.drawing-board-control-size-range-input').val(size);
        $('.drawing-board-control.drawing-board-control-size').find('.drawing-board-control-size-dropdown-current span').css({
            width: size + 'px',
            height: size + 'px',
            borderRadius: size + 'px',
            marginLeft: -1*size/2 + 'px',
            marginTop: -1*size/2 + 'px'
        });
        this.dom.$controls.find('.drawing-board-control-size .drawing-board-control-inner').attr('title', size);
        DrawingBoard.Control.Size.val = size;
        if(!silent)
            this.ev.trigger('size:changed', size);
    },

	setColor: function(color) {
		var that = this;
		color = color || this.color;
		if (!DrawingBoard.Utils.isColor(color))
			return false;
		this.color = color;
		if (this.opts.eraserColor !== "transparent" && this.mode === "eraser") {
			var setStrokeStyle = function(mode) {
				if (mode !== "eraser")
					that.strokeStyle = that.color;
				that.ev.unbind('board:mode', setStrokeStyle);
			};
			this.ev.bind('board:mode', setStrokeStyle);
		} else
			this.ctx.strokeStyle = this.color;

        $('.drawing-board-control-colors-current')
            .css('background-color', color)
            .data('color', color);
	},

    getColor: function(){
        return this.color;
    },

    text: function(e, silent){
        if(this.isDisabled()) return;
        var text = prompt('Digite o texto: ') || '';
        this.textwrite(e.coords.x, e.coords.y, text);
        this.ev.trigger('board:textnow', e.coords.x, e.coords.y, text);
    },

    textwrite: function(x,y,text){

        var txt = new createjs.Text(text, this.ctx.lineWidth+'px Verdana', this.color);
        txt.x = x;
        txt.y = y;
        //txt.rotation = 20;
        //txt.outline = true;
        this.stage.addChild(txt);

        this.stage.update();

    },

    toggleControls: function(show){
        this.dom.$controls.toggleClass('drawing-board-controls-hidden', show);
    },

    isDisabled: function(){
        return this.dom.$controls.hasClass('drawing-board-controls-hidden');
    },

    mark: function(startX, startY, x, y, silent){
        if(this.isDisabled()) return;
        silent = silent || false;
        this.markNow(startX, startY, x, y);
        if (!silent) this.ev.trigger('board:mark', {startX: startX, startY: startY, x: x, y: y});
    },

    markNow: function(startX, startY, x, y){
        this.stage2.clear();
        this.shape = new createjs.Shape();
        this.shape.x = startX;
        this.shape.y = startY;
        this.stage.addChildAt(this.shape,0);
        this.shape.graphics.beginFill(this.color).drawRect(-10, -10, x-startX, y-startY);
        this.stage.update();
    },

    markTemp: function(e){
        this.shape2.graphics.clear().beginStroke(this.color).drawRect(-10, -10, e.coords.x-this.startX, e.coords.y-this.startY);
        this.stage2.update();
    },

    fill: function(e, silent) {
        if(!this.isDisabled()) {
            this.fillnow(e, silent);
        }
    },

    /**
     * Fills an area with the current stroke color.
     */
    fillnow: function(e, silent) {
        silent = silent || false;

        if (this.getImg() === this.blankCanvas) {
            this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.width);
            this.ctx.fillStyle = this.color;
            this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
            return;
        }
        var img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        // constants identifying pixels components
        var INDEX = 0, X = 1, Y = 2, COLOR = 3;
        // target color components
        var stroke = this.ctx.strokeStyle;
        var r = parseInt(stroke.substr(1, 2), 16);
        var g = parseInt(stroke.substr(3, 2), 16);
        var b = parseInt(stroke.substr(5, 2), 16);
        // starting point
        var start = DrawingBoard.Utils.pixelAt(img, parseInt(e.coords.x, 10), parseInt(e.coords.y, 10));
        var startColor = start[COLOR];
        var tolerance = this.opts.fillTolerance;
        var useHack = this.opts.fillHack; //see https://github.com/Leimi/drawingboard.js/pull/38
        // no need to continue if starting and target colors are the same
        if (DrawingBoard.Utils.compareColors(startColor, DrawingBoard.Utils.RGBToInt(r, g, b), tolerance))
            return;
        // pixels to evaluate
        var queue = [start];
        // loop vars
        var pixel, x, y;
        var maxX = img.width - 1;
        var maxY = img.height - 1;
        function updatePixelColor(pixel) {
            img.data[pixel[INDEX]] = r;
            img.data[pixel[INDEX] + 1] = g;
            img.data[pixel[INDEX] + 2] = b;
        }
        while ((pixel = queue.pop())) {
            if (useHack)
                updatePixelColor(pixel);
            if (DrawingBoard.Utils.compareColors(pixel[COLOR], startColor, tolerance)) {
                if (!useHack)
                    updatePixelColor(pixel);
                if (pixel[X] > 0) // west
                    queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X] - 1, pixel[Y]));
                if (pixel[X] < maxX) // east
                    queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X] + 1, pixel[Y]));
                if (pixel[Y] > 0) // north
                    queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X], pixel[Y] - 1));
                if (pixel[Y] < maxY) // south
                    queue.push(DrawingBoard.Utils.pixelAt(img, pixel[X], pixel[Y] + 1));
            }
        }
        this.ctx.putImageData(img, 0, 0);

        if (!silent) this.ev.trigger('board:fillnow', e);
    },


	/**
	 * Drawing handling, with mouse or touch
	 */

	initDrawEvents: function() {
		this.isDrawing = false;
		this.isMouseHovering = false;
		this.coords = {};
		this.coords.old = this.coords.current = this.coords.oldMid = { x: 0, y: 0 };

		this.dom.$canvas.on('mousedown touchstart', $.proxy(function(e) {
			this._onInputStart(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mousemove touchmove', $.proxy(function(e) {
			this._onInputMove(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mousemove', $.proxy(function(e) {

		}, this));

		this.dom.$canvas.on('mouseup touchend', $.proxy(function(e) {
			this._onInputStop(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mouseover', $.proxy(function(e) {
			this._onMouseOver(e, this._getInputCoords(e) );
		}, this));

		this.dom.$canvas.on('mouseout', $.proxy(function(e) {
			this._onMouseOut(e, this._getInputCoords(e) );

		}, this));

		$('body').on('mouseup touchend', $.proxy(function(e) {
			this.isDrawing = false;
		}, this));

		if (window.requestAnimationFrame) requestAnimationFrame( $.proxy(this.draw, this) );
	},

	draw: function() {
		//if the pencil size is big (>10), the small crosshair makes a friend: a circle of the size of the pencil
		//todo: have the circle works on every browser - it currently should be added only when CSS pointer-events are supported
		//we assume that if requestAnimationFrame is supported, pointer-events is too, but this is terribad.
		if (window.requestAnimationFrame && this.ctx.lineWidth > 10 && this.isMouseHovering) {
			this.dom.$cursor.css({ width: this.ctx.lineWidth + 'px', height: this.ctx.lineWidth + 'px' });
			var transform = DrawingBoard.Utils.tpl("translateX({{x}}px) translateY({{y}}px)", { x: this.coords.current.x-(this.ctx.lineWidth/2), y: this.coords.current.y-(this.ctx.lineWidth/2) });
			this.dom.$cursor.css({ 'transform': transform, '-webkit-transform': transform, '-ms-transform': transform });
			this.dom.$cursor.removeClass('drawing-board-utils-hidden');
		} else {
			this.dom.$cursor.addClass('drawing-board-utils-hidden');
		}

        if (!this.isDisabled() && (this.getMode()=='pencil' || this.getMode()=='eraser') && this.isDrawing) {
			var currentMid = this._getMidInputCoords(this.coords.current);
			this.ctx.beginPath();
			this.ctx.moveTo(currentMid.x, currentMid.y);
			this.ctx.quadraticCurveTo(this.coords.old.x, this.coords.old.y, this.coords.oldMid.x, this.coords.oldMid.y);
			this.ctx.stroke();

            this.ev.trigger('board:drawnow', currentMid.x, currentMid.y, this.coords.old.x, this.coords.old.y, this.coords.oldMid.x, this.coords.oldMid.y);

			this.coords.old = this.coords.current;
			this.coords.oldMid = currentMid;
		}

		if (window.requestAnimationFrame) requestAnimationFrame( $.proxy(function() { this.draw(); }, this) );
	},

    drawnow: function(midx, midy, oldx, oldy, oldMidx, oldMidy) {

        //console.log('drawing: '+midx +','+ midy +' - '+ oldx +','+ oldy +' - '+ oldMidx +','+  oldMidy);
        this.ctx.beginPath();
        this.ctx.moveTo(midx, midy);
        this.ctx.quadraticCurveTo(oldx, oldy, oldMidx, oldMidy);
        this.ctx.stroke();

    },

    drawOval: function(x, y, commit, silent){
        if(this.isDisabled()) return;

        silent = silent || false;

        this.ctx2.clearRect(0, 0, this.canvas2.width, this.canvas2.height);
        var currentCtx = this.ctx2;
        if(commit){
            currentCtx = this.ctx;
        }

        this.drawOvalNow(currentCtx,x,y,this.startX,this.startY);

        if (!silent && commit) this.ev.trigger('board:drawOval', x,y,this.startX,this.startY);
    },

    drawOvalNow: function(currentCtx,x,y,startX,startY){

        if(!currentCtx) currentCtx = this.ctx;

        currentCtx.beginPath();
        currentCtx.moveTo(startX, startY + (y - startY) / 2);
        currentCtx.bezierCurveTo(startX, startY, x, startY, x, startY + (y - startY) / 2);
        currentCtx.bezierCurveTo(x, y, startX, y, startX, startY + (y - startY) / 2);
        currentCtx.closePath();
        currentCtx.stroke();

    },

	_onInputStart: function(e, coords) {
		this.coords.current = this.coords.old = coords;
		this.coords.oldMid = this._getMidInputCoords(coords);
		this.isDrawing = true;

        //elipse
        this.startX = coords.x;
        this.startY = coords.y;
        if(this.getMode()!='text' && this.getMode()!='filler') {
            this.isDown = true;
        }

        //mark
        if(this.getMode()=='mark'){
            this.shape2 = new createjs.Shape();
            this.shape2.x = this.startX;
            this.shape2.y = this.startY;
            this.stage2.addChildAt(this.shape2,0);
        }

		if (!window.requestAnimationFrame) this.draw();

		this.ev.trigger('board:startDrawing', {e: e, coords: coords});
		e.stopPropagation();
		e.preventDefault();
	},

	_onInputMove: function(e, coords) {
		this.coords.current = coords;
		this.ev.trigger('board:drawing', {e: e, coords: coords});

        //elipse
        if (this.getMode()=='elipse' && !this.isDown) {
            return;
        } else if (this.getMode()=='elipse' && this.isDown) {
            this.drawOval(coords.x, coords.y, false);
        }

        //mark
        if (this.getMode()=='mark' && !this.isDown) {
            return;
        } else if (this.getMode()=='mark' && this.isDown) {
            this.markTemp({e: e, coords: coords});
        }

		if (!window.requestAnimationFrame) this.draw();

		e.stopPropagation();
		e.preventDefault();
	},

	_onInputStop: function(e, coords) {

        //elipse
        if (this.getMode()=='elipse' && !this.isDown) {
            return;
        } else if (this.getMode()=='elipse' && this.isDown) {
            this.drawOval(coords.x, coords.y, true);
        }

        //mark
        if(this.getMode()=='mark' && !this.isDown){
            return;
        }else if(this.getMode()=='mark' && this.isDown){
            this.mark(this.startX, this.startY, coords.x, coords.y, false);
        }

        e.preventDefault();
        e.stopPropagation();
        this.isDown = false;

		if (this.isDrawing && (!e.touches || e.touches.length === 0)) {
			this.isDrawing = false;

			this.saveWebStorage();
			this.saveHistory();

			this.ev.trigger('board:stopDrawing', {e: e, coords: coords});
			this.ev.trigger('board:userAction');
			e.stopPropagation();
			e.preventDefault();
		}
	},

	_onMouseOver: function(e, coords) {
		this.isMouseHovering = true;
		this.coords.old = this._getInputCoords(e);
		this.coords.oldMid = this._getMidInputCoords(this.coords.old);

		this.ev.trigger('board:mouseOver', {e: e, coords: coords});
	},

	_onMouseOut: function(e, coords) {
		this.isMouseHovering = false;

		this.ev.trigger('board:mouseOut', {e: e, coords: coords});
	},

	_getInputCoords: function(e) {
		e = e.originalEvent ? e.originalEvent : e;
		var x, y;
		if (e.touches && e.touches.length == 1) {
			x = e.touches[0].pageX;
			y = e.touches[0].pageY;
		} else {
			x = e.pageX;
			y = e.pageY;
		}
		return {
			x: x - this.dom.$canvas.offset().left,
			y: y - this.dom.$canvas.offset().top
		};
	},

	_getMidInputCoords: function(coords) {
		return {
			x: this.coords.old.x + coords.x>>1,
			y: this.coords.old.y + coords.y>>1
		};
	}
};
