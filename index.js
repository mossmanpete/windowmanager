var util = require("util")
  , EventEmitter = require('events').EventEmitter
  , revert = require("revert-keys")
  , {parse:parseArgs} = require("shell-quote")
  , {manageXServer} = require('./lib/XManager')
  , {Launcher} = require("./lib/Launcher")
  , {parseShortcut} = require("./lib/Xutils/XKeyboard")
async function manageDisplay(opts={}){
  const m_options = Object.assign({}, opts); //make a copy since we want to modify options
  if(!m_options.headless){
    try{
      m_options.manager = await manageXServer(opts);
    }catch(e){
      console.error("Failed to start as Root Window. Falling back to headless mode", e);
    }
  }
  return new WindowManager(m_options);
}



class WindowManager extends EventEmitter{
  constructor({manager, shortcuts = []}={}){
    super();
    this.shortcuts = new Map();
    this.launcher =  new Launcher();
    this.hasChild = false;
    this.launcher.on("error",(e)=>{
      e.type = "launcher"; //keep original stack trace and add easy type information
      this.emit("error", e);
    });
    this.launcher.on("stdout",function(o){
      console.log("player stdout : "+o);
    });
    this.launcher.on("stderr",function(o){
      console.log("player stderr : "+o);
    });
    this.launcher.on("end",()=>{
      console.log("Launcher End Event");
      this.hasChild = false;
      if(!this.active){
        this.emit("end");
      }
    });
    this.cancelError = null;
    if(manager){
      this.manager = manager;
      this.manager.on("expose",()=>{
        console.log("EXPOSE EVENT")
        this.wait();
        if(!this.active){
          this.emit("end")
        }
      })
      this.manager.on("error",(e)=>{
        e.type = "x11"; //keep original stack trace and add easy type information
        this.emit("error", e);
      });
      if(shortcuts){
        try{
          this.updateShortcuts(shortcuts);
        }catch(e){
          console.error("Failed to update shortcuts : ",e);
        }
      }
      this.manager.on("keydown",(e)=>{
        const action = this.shortcuts.get(e.uid);
        //console.log("keydown :", e, action);
        if(action){
          this.emit("command", action);
        }
      })
      //handle waiting state set / cancel
    }else{
      console.log("Running in headless mode");
    }
    
  }

  wait(){
    //this.cancelWait(); //Should not happend according to state machine
    this._wait_timeout = setTimeout(()=>{
      console.log("wait timer end. State : ", this.active);
      if(this.manager.isExposed){
        this.manager.focus();
      }
    }, 2000);
  }

  cancelWait(){
    clearTimeout(this._wait_timeout);
  }
  /**
   * Uses a Map or a map-like array to override keyboard shortcuts
   * @param {Array|Map} sh - new shortcuts to replace the previous set 
   */
  updateShortcuts(sh){
    const new_shortcuts = new Map(sh);
    for(const [code] of this.shortcuts){
      if(new_shortcuts.has(code)){
        this.manager.unregisterShortcut(code);
      }
    }
    for (const [code, action] of new_shortcuts){
      if(!this.shortcuts.has(code))
      this.registerShortcut(code, action);
    }
    this.shortcuts = new Map(sh.map(([keys, action])=>{
      const code = parseShortcut(keys).uid;
      return [code, action];
    }))
  }

  registerShortcut(code, action){
    console.log("Register %s as shortcut for %s", code, action);
    const registered_shortcut = this.manager.registerShortcut(code);
          this.shortcuts.set(registered_shortcut.uid, action);
  }
  /**
   * Send a set of key to send to the X server like they were simultaneously pressed
   * If the manager runs headless, does nothing
   * @param {string} keys - Formatted set of keys  (eg. Ctrl+Shift+F)
   * @see parseShortcut 
   */
  sendKeys(keys){
    if(this.manager) return this.manager.sendKeys(keys);
    else return Promise.resolve();
  }

  /**
   * Show an error on screen
   * Does nothing in headless mode
   * @param {string} title 
   * @param {string} text 
   * @param {number} [timeout] 
   */
  showError(title, text, timeout=5000){
    if(!this.manager){
      return;
    }
    if(typeof this.cancelError === "function"){
      this.cancelError();
      this.cancelError = null;
    }
    this.manager.drawError(title, text);
    let t = setTimeout(()=>{
      this.manager.unmapError();
    }, timeout);
    this.cancelError = ()=> clearTimeout(t);
  }

  /**
   * Wrap an error directly generated from spawn(). Generally some form of ENOENT or EACCESS
   * Displays the error using this.showError() if possible
   * @param {string} source - source command the error originated from
   * @param {Error} orig - original error 
   */
  wrapChildError(source, orig){
    let e = new Error(orig.message);
    e.code = orig.code || "UNKNOWN";
    this.showError(
      `${source} : ${e.code}`,
      `${e.message}`
    );
    this.emit("error", e);
  }

  /**
   * Launch a file using Desktop entries if possible
   * @param {string} file File we wish to start from a launcher defined in desktop entries or as an executable as last resort
   * @param {object} opts Options to pass as third argument to [spawn](https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options) 
   */
  launch (file, opts={}){ // FIXME options are ignored right now?!
    this.cancelWait();
    this.hasChild = true;
    return this.launcher.start(file, opts)
    .catch((e)=>{
      this.wrapChildError(file, e);
    });
  }
  /**
   * Direct-spawn a file, bypassing xdg-apps search for a launcher
   * @param {string} command - absolute path to an executable file or name of a command in $PATH
   * @param {Array|string} args - array of arguments or string to be parsed by shell-quote
   * @param {object} options - set of options sent directly to [spawn](https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options) 
   */
  spawn(command, args, options){
    if(typeof args === "string"){
      args = parseArgs(args);
    }
    this.cancelWait();
    this.hasChild = true;
    this.launcher.spawn(command, args, options)
    .catch((e)=>{
      this.wrapChildError(command, e);
    });
  }

  get active(){
    return this.hasChild && (!this.manager || this.manager.isExposed);
  }

  end (){
    this.launcher.killChild();
    this.hasChild = false;
  }

  // Like this.end() but force shows the background image
  // No longer required once this.end() will handle focus properly
  expose (){
    this.launcher.killChild();
    if(this.manager) this.manager.focus();
  }

  //Fully close the window manager
  close (){
    this.cancelWait();
    this.launcher.close();
    if(this.manager) {
      this.manager.exit();
      //this.removeListener("end", this._on_end_listener);
    } //Closing background window.
  }
}


module.exports = {manageDisplay, WindowManager};
