/* global pushRecord _ sleep kubernetes secName registerEvents eventName sshKey configName */
/* exported Job WaitGroup run */

// This is the runner wrapping script.
console.log("Loading ACID core")
console.log(pushRecord.repository.name)

// The default image is stock ubuntu 16.04 + make and git.
var acidImage = "acid-ubuntu:latest"

// EventHandler describes the list of events that Acid is aware of.
function EventHandler() {
  // Every event handler gets the param 'data', which is the body of the request.
  this.push = function() {}
  this.pullRequest = function() {}
}

// Event describes an event that was triggered.
// An event is passed to an event hanlder. The event handler can use this
// object to acquire the data that triggered the event
function Event(eventName, req) {
  // name is the event name (e.g. 'push')
  this.name = eventName
  // request is the event data from the request.
  // For a GitHub hook, it's the payload received from GitHub
  this.request = req
  // config contains the configuration for this request.
  // This is a dictionary.
  this.config = {}
}

// Prototype for Job.
function Job(name, tasks) {
  var my = this

  // Name will become the prefix for the pod/configmap names.
  this.name = name;
  // Tasks is the list of tasks to run. They are executed in sequence inside of
  // a shell (/bin/sh).
  this.tasks = tasks;

  // A collection of name/value pairs of environment variables.
  this.env = {};

  // The image and an optional tag.
  this.image = acidImage;

  // A map of ENV_VAR names and Secret names. This will populate the environment
  // variable with the value found in the secret.
  // This will override a matching env var from the env map.
  this.secrets = {}

  // podName is set by run(), and contains the name of the pod created.
  this.podName

  // run sends this job to Kubernetes.
  this.run = function() {
    this.background(pushRecord)
    this.wait()

    return this
  };

  this.background = function() {
    this.podName = run(this, pushRecord);
  };

  // waitUntilDone is here for backwards compatibility, but does nothing.
  // DEPRECATED: Will be removed during Alpha
  this.waitUntilDone = function() {

    return this
  }

  // wait waits until a pod hits "Succeeded"
  //
  // wait() can be called on backgrounded objects.
  //
  // wait() is automatically called by this.run.
  //
  // If pod returns "Failed", this throws an exception.
  // If pod runs for more than 15 minutes (300 * 3-second intervals), throws a timeout exception.
  this.wait = function() {
    for (var i = 0; i < 300; i++) {
      console.log("checking status of " + my.podName)
      var k = kubernetes.withNS("default")
      var mypod = k.coreV1.pod.get(my.podName)

      console.log(JSON.stringify(mypod))
      console.log("Pod " + my.podName + " is in state " + mypod.status.phase)

      if (mypod.status.phase == "Failed") {
        throw "Pod " + my.podName + " failed to run to completion";
      }
      if (mypod.status.phase == "Succeeded") {
        return true
      }
      // Sleep for a defined amount of time.
      sleep(3)
    }
    throw "timed out waiting for pod " + my.podName + " to run"
  };
}

// WaitGroup waits for multiple jobs to finish. It will throw an error
// as soon as a job reports an error.
function WaitGroup() {
  this.jobs = []

  // add adds a new job to the waitgroup
  this.add = function(job) {
    this.jobs.push(job)
  }

  // run runs every job in the group, and then waits for them to complete.
  this.run = function() {
    this.jobs.forEach(function (j) {
      j.background()
    })
    this.wait()
  }

  // wait waits until jobs are complete. Note that this does not run the jobs. They
  // must be started externally. (See WaitGroup.run or Job.background)
  this.wait = function() {
    this.jobs.forEach(function (j) {
      j.wait()
    })
  }
}

// run runs a job for a pushRecord. It does not wait for the job to complete.
// This is a low-level primitive.
function run(job, pushRecord) {
  // $JOB-$TIME-$GITSHA
  var k8sName = job.name + "-" + Date.now() + "-" + pushRecord.head_commit.id.substring(0, 8);
  var cmName = k8sName
  var runnerName = k8sName
  var cm = newCM(cmName)
  var runner = newRunnerPod(runnerName)

  runner.metadata.labels.jobname = job.name
  runner.metadata.labels.belongsto = pushRecord.repository.owner.name + "-" + pushRecord.repository.name
  runner.metadata.labels.commit = pushRecord.head_commit.id

  // Add env vars.
  var envVars = []

  // _.each(job.env, function(val, key, l) {
  _.each(job.env, function(val, key) {
    envVars.push({name: key, value: val});
  });
  // Add secrets as env vars.
  _.each(job.secrets, function(val, key) {

    // Some secrets we explicitly block.
    if (_.contains(["secret"], val)) {
      return
    }

    // Get secrets from the given secName
    envVars.push({
      name: key,
      valueFrom: {
        secretKeyRef: {name: secName, key: val}
      }
    });
  });

  if (sshKey) {
    envVars.push({
      name: "ACID_REPO_KEY",
      value: sshKey
    })
  }

  // Add top-level env vars. These must override any attempt to set the values
  // to something else.
  envVars.push({ name: "CLONE_URL", value: pushRecord.repository.clone_url })
  envVars.push({ name: "SSH_URL", value: pushRecord.repository.ssh_url })
  envVars.push({ name: "GIT_URL", value: pushRecord.repository.git_url })
  envVars.push({ name: "HEAD_COMMIT_ID", value: pushRecord.head_commit.id })
  runner.spec.containers[0].env = envVars

  // Add config map volume
  runner.spec.volumes = [
    { name: cmName, configMap: {name: cmName }}
    // , { name: "idrsa", secret: { secretName: secName }}
  ];
  runner.spec.containers[0].volumeMounts = [
    { name: cmName, mountPath: "/hook/data"},
    // , { name: "idrsa", mountPath: "/hook/ssh", readOnly: true}
  ];

  // Override the image only if the user sets one.
  if (job.image) {
    runner.spec.containers[0].image = job.image
  }

  // Join the tasks to make a new command:
  var newCmd = job.tasks.join(" && ")

  cm.data["main.sh"] = newCmd

  var k = kubernetes.withNS("default")

  console.log("Creating configmap " + cm.metadata.name)
  console.log(JSON.stringify(cm))
  k.extensions.configmap.create(cm)
  console.log("Creating pod " + runner.spec.containers[0].name)
  console.log(JSON.stringify(runner))
  k.coreV1.pod.create(runner)
  console.log("running...")

  return runnerName;
}

function newRunnerPod(podname) {
  return {
    "kind": "Pod",
    "apiVersion": "v1",
    "metadata": {
      "name": podname,
      "namespace": "default",
      "labels": {
        "heritage": "Quokka",
        "managedBy": "acid"
      }
    },
    "spec": {
      "restartPolicy": "Never",
      "containers": [
        {
          "name": "acidrun",
          "image": acidImage,
          "command": [
            "/hook.sh"
          ],
          // FIXME: Change to "IfNotPresent"
          "imagePullPolicy": "Always"
        }
      ]
    }
  };
}


function newCM(name) {
  return {
    "kind": "ConfigMap",
    "apiVersion": "v1",
    "metadata": {
        "name": name,
        "namespace": "default",
        "labels": {
            "heritage": "Quokka",
        },
    },
    "data": {
        "main.sh": "echo hello && echo goodbye"
    },
  };
}

// ===========================
// Main loader
// ===========================

console.log("Loaded ACID")

if (!registerEvents) {
  throw "No event handlers defined"
}


var e = new Event(eventName, pushRecord)

e.config = {
  // MPB: I don't think there is any reason to pass this in, is there?
  // "sshKey": sshKey,
  "configName": configName
}

var eventHandler = new EventHandler()

console.log(JSON.stringify(eventHandler))
registerEvents(eventHandler)

console.log("events loaded. Firing " + eventName)

// fn = lookupEvent(eventName, eventHandler)
// fn(pushRecord)
switch (eventName) {
  case "push":
    eventHandler.push(e)
    break
  default:
    throw "Unknown event " + eventName
}
