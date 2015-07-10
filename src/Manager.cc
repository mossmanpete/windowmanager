#include "Manager.h"

using namespace v8;

Persistent<Function> Manager::constructor;

Manager::Manager() {
  Isolate* isolate = Isolate::GetCurrent();
  HandleScope scope(isolate);
  if ( ( this->dpy = XOpenDisplay(NULL) ) == NULL ) {
    isolate->ThrowException(Exception::Error(String::NewFromUtf8(isolate,"cannot connect to X server " )));

  }else{
    this->screen = DefaultScreen(this->dpy);
    this->root = RootWindow(this->dpy, this->screen);
  }
}

Manager::~Manager() {
  if(this->dpy){
    XCloseDisplay(this->dpy);
  }
}

void Manager::Init(Handle<Object> exports) {
  Isolate* isolate = Isolate::GetCurrent();

  // Prepare constructor template
  Local<FunctionTemplate> tpl = FunctionTemplate::New(isolate, New);
  tpl->SetClassName(String::NewFromUtf8(isolate, "Manager"));
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  // Prototype
  NODE_SET_PROTOTYPE_METHOD(tpl, "manage", Manage);

  constructor.Reset(isolate, tpl->GetFunction());
  exports->Set(String::NewFromUtf8(isolate, "Manager"),
               tpl->GetFunction());
}

void Manager::New(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = Isolate::GetCurrent();
  HandleScope scope(isolate);

  if (args.IsConstructCall()) {
    // Invoked as constructor: `new Manager(...)`
    Manager* obj = new Manager();
    obj->Wrap(args.This());
    args.GetReturnValue().Set(args.This());
  } else {
    // Invoked as plain function `Manager(...)`, turn into construct call.
    const int argc = 1;
    Local<Value> argv[argc] = { args[0] };
    Local<Function> cons = Local<Function>::New(isolate, constructor);
    args.GetReturnValue().Set(cons->NewInstance(argc, argv));
  }
}
void Manager::Manage(const v8::FunctionCallbackInfo<v8::Value>& args){
  Isolate* isolate = Isolate::GetCurrent();
  HandleScope scope(isolate);
  Manager* obj = ObjectWrap::Unwrap<Manager>(args.Holder());
  XSelectInput(obj->dpy,obj->root,
                   SubstructureRedirectMask|SubstructureNotifyMask|ButtonPressMask
                  |EnterWindowMask|LeaveWindowMask|StructureNotifyMask
                  |PropertyChangeMask);
  obj->scan();
  XSync(obj->dpy, False);
  //Now manage events
  int fd = XConnectionNumber(obj->dpy);
  uv_poll_t* handle = new uv_poll_t;
  handle->data = obj;
  //obj.Ref(); //Necessary?
  uv_poll_init(uv_default_loop(), handle, fd);
  uv_poll_start(handle, UV_READABLE, EIO_Loop);
  args.GetReturnValue().Set(Number::New(isolate, fd));
}

void Manager::EIO_Loop(uv_poll_t* handle, int status, int events) {
  XEvent event;
  Manager* obj = static_cast<Manager*>(handle->data);
  // main event loop
  while(XPending(obj->dpy)) {
   XNextEvent(obj->dpy, &event);
   //Handle event
   fprintf(stderr, "Got %s (%d)\n", event_names[event.type], event.type);
   switch(event.type){
     case MapRequest:
      obj->event_maprequest(&event);
      break;
   }
 }
}
void Manager::event_maprequest(XEvent *e) {
  // read the window attrs, then add it to the managed windows...
  XWindowAttributes wa;
  XMapRequestEvent *ev = &e->xmaprequest;
  if(!XGetWindowAttributes(this->dpy, ev->window, &wa)) {
    return;
  }
  if(wa.override_redirect)
    return;
  std::list<Window>::iterator find = std::find(this->windows.begin(), this->windows.end(), ev->window);
  if(find == this->windows.end()) {
    // only map new windows
    this->add_window(ev->window, &wa);
    //nwm_emit(onRearrange, NULL);
  }
}
void Manager::scan (){
  unsigned int i, num;
  Window d1, d2, *wins = NULL;
  XWindowAttributes watt;
  if(XQueryTree(this->dpy, this->root, &d1, &d2, &wins, &num)) {
   for(i = 0; i < num; i++) {
     // if we can't read the window attributes,
     // or the window is a popup (transient or override_redirect), skip it
     if(!XGetWindowAttributes(this->dpy, wins[i], &watt)
     || watt.override_redirect || XGetTransientForHint(this->dpy, wins[i], &d1)) {
       continue;
     }
     // visible or minimized window ("Iconic state")
     if(watt.map_state == IsViewable )//|| getstate(wins[i]) == IconicState)
       add_window(wins[i], &watt);
   }
   for(i = 0; i < num; i++) { /* now the transients */
     if(!XGetWindowAttributes(this->dpy, wins[i], &watt))
       continue;
     if(XGetTransientForHint(this->dpy, wins[i], &d1)
     && (watt.map_state == IsViewable )) //|| getstate(wins[i]) == IconicState))
       add_window(wins[i], &watt);
   }
   if(wins) {
     XFree(wins);
   }
  }
}
void Manager::add_window(Window win, XWindowAttributes *watt){
  Window trans = None;
  Bool isfloating = False;

  XGetTransientForHint(this->dpy, win, &trans);
  isfloating = (trans != None);
  this->windows.push_back(win);

  if(isfloating) {
    XRaiseWindow(this->dpy, win);
  }
  XChangeSaveSet(this->dpy,win,SetModeInsert);
  XReparentWindow(this->dpy,win,this->root,0,0);
  XMapWindow(this->dpy, win);
}