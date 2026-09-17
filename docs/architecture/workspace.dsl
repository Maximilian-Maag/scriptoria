workspace "Scriptoria" "Web frontend for selecting, running, interactively driving and collecting the results of existing Linux scripts that live on a script VM." {

    # Descriptions here are deliberately short. This file is rendered as
    # diagrams, and a diagram whose boxes carry paragraphs is a diagram nobody
    # reads. The reasoning lives in docs/architecture/adr/ and is linked from
    # the view descriptions instead.

    model {
        administrator = person "Administrator" "Runs scripts on the script VM through the platform." "Person"
        root = person "Root Account" "Manages the platform: areas, script directories, group entitlements." "Person"
        script_owner = person "Script Owner" "Owns the scripts. Does not use the platform (NFR-06)." "Person"

        directory = softwaresystem "Directory Service" "Authoritative for every account and group (NFR-03, NFR-04)." "Existing System"
        script_vm = softwaresystem "Script VM" "Holds the scripts in directories, runs them, and reaches other machines itself when a script needs to." "Existing System"
        target_systems = softwaresystem "Target Systems" "Whatever the scripts manage. Reached from the script VM, never from the platform." "Existing System"
        monitoring = softwaresystem "Monitoring System" "Watches the scheduled runs on the service VMs (NFR-16)." "Existing System"
        logs = softwaresystem "Log Platform" "Receives the structured audit and operations logs (NFR-05)." "Existing System"

        scriptoria = softwaresystem "Scriptoria" "Presents the scripts, starts them in their own service context, streams their terminal and serves their results." {

            frontend = container "Frontend" "The web interface and the API proxy." "Next.js / React / Tailwind / xterm.js" {
                ui_proxy = component "API Proxy" "The browser's only REST route to the control plane."
                ui_auth = component "Login" "Username and password, posted to the proxy."
                ui_nav = component "Area Navigation" "Category, area, then its scripts and jobs."
                ui_catalog = component "Script Catalog" "An area's scripts, each with a criticality badge."
                ui_console = component "Run Console" "Status line, terminal and stop control."
                ui_stream = component "Terminal Stream Client" "Binary WebSocket frames in and out of xterm.js."
                ui_results = component "Result View" "List, preview, copy, download and ZIP."
                ui_schedules = component "Recurring Jobs" "Schedules, last successful run, run-now."
                ui_admin = component "Administration" "Areas, directories, entitlements. Root only."
            }

            backend = container "Backend (Control Plane)" "Every privileged operation. Served through a custom Node server (ADR-007)." "Next.js / TypeScript / Drizzle / Zod / ws" {
                api_auth = component "Auth Routes" "Credentials in, session cookie out."
                api_areas = component "Area Routes" "Area administration. Root-guarded."
                api_catalog = component "Catalog Routes" "The session's areas, and the scripts in one."
                api_runs = component "Run Routes" "Start, poll and abort a run."
                api_stream = component "Stream Gateway" "The terminal WebSocket. Not a route handler (ADR-007)."
                api_results = component "Result Routes" "List, stream one file, or stream the set as a ZIP."
                api_schedules = component "Schedule Routes" "Recurring jobs and their schedules."
                api_audit = component "Audit Routes" "The filterable audit log. Root only."
                api_docs = component "OpenAPI / Swagger UI" "Generated from the same schemas the routes validate with."
                api_health = component "Health & Metrics" "Liveness, readiness and metrics (NFR-16)."

                svc_auth = component "Auth Service" "Simple bind with the caller's own credentials."
                svc_authz = component "Authorization Service" "Rebuilds the area set from the directory at every login (NFR-03)."
                svc_areas = component "Area Administration Service" "Areas, the script directories mapped onto them, group references."
                svc_catalog = component "Script Catalog Service" "Caches the parsed script headers (ADR-004)."
                svc_runs = component "Run Orchestrator" "The run state machine. The only component that may dispatch one."
                svc_results = component "Result Service" "Lists, streams and ZIPs a run's output files (FA-09.5)."
                svc_schedules = component "Schedule Service" "Reads and writes the crontab; computes the next run (ADR-005)."
                svc_audit = component "Audit Service" "Records who did what, where, when and with what outcome."

                lib_result = component "Result<T> / toResponse" "The one mapping from a domain outcome to an HTTP response."
                lib_repo = component "Repository Layer" "The only component that speaks SQL."
                lib_session = component "Session Store" "Opaque server-side sessions behind an httpOnly cookie."
            }

            runner = container "Runner Worker" "Holds the SSH and PTY session to the script VM. No listening port." "Node / TypeScript / ssh2" {
                run_consumer = component "Job Consumer" "Claims one run per worker off the queue."
                run_driver = component "Execution Driver" "The ExecutionTarget interface (ADR-001)."
                run_ssh = component "SSH Client" "Outbound SSH to the script VM, keyed, host key pinned."
                run_pty = component "PTY Session Manager" "Allocates the terminal and runs the script in it (NFR-08)."
                run_abort = component "Abort Controller" "Staged SIGINT, SIGTERM, SIGKILL to the process group (ADR-003)."
                run_publisher = component "Stream Publisher" "Appends the PTY bytes to the run's capped stream."
                run_stdin = component "Stdin Subscriber" "Routes keystrokes to the worker holding this PTY."
                run_collector = component "Result Collector" "Lists and reads the output directory over SFTP."
                run_scanner = component "Script Scanner" "Reads each script's header block, never its body."
                run_cron = component "Crontab Adapter" "Reads and writes the script VM's crontab."
            }

            database = container "Database" "Areas, script metadata, runs, results and the audit trail." "PostgreSQL" "Database"
            broker = container "Session & Stream Store" "Sessions, one capped stream per run, and the job queue." "Redis" "Database"
        }

        # ── System level ──────────────────────────────────────────────────────────
        administrator -> scriptoria "Runs scripts, answers their dialogues, fetches results" "HTTPS"
        root -> scriptoria "Maintains areas, directories, entitlements and schedules" "HTTPS"
        script_owner -> script_vm "Places and owns the scripts"
        scriptoria -> directory "Binds the account, reads its groups" "LDAPS"
        scriptoria -> script_vm "Runs scripts on a PTY, fetches results, maintains the crontab" "SSH / SFTP"
        script_vm -> target_systems "The scripts read and modify, with their own credentials"
        monitoring -> script_vm "Watches the scheduled runs"
        scriptoria -> logs "Audit and operations logs" "Syslog"

        # ── Container level ───────────────────────────────────────────────────────
        administrator -> frontend "Uses the web interface" "HTTPS"
        root -> frontend "Administers areas and schedules" "HTTPS"
        frontend -> backend "REST, server-side, with the session cookie" "JSON/HTTPS"
        frontend -> backend "Terminal stream, browser to control plane directly" "WSS"
        backend -> directory "Simple bind and group resolution" "LDAPS"
        backend -> database "Reads and writes" "SQL/TCP"
        backend -> broker "Sessions, run streams, job dispatch" "RESP/TCP"
        backend -> logs "Structured audit and operations logs" "Syslog"
        runner -> broker "Consumes jobs, publishes terminal bytes, subscribes to stdin" "RESP/TCP"
        runner -> database "Run state and run events" "SQL/TCP"
        runner -> script_vm "Outbound SSH with a PTY, SFTP on the same connection" "SSH / SFTP"

        # ── Frontend components ───────────────────────────────────────────────────
        administrator -> ui_auth "Signs in"
        root -> ui_auth "Signs in"
        administrator -> ui_nav "Opens an area"
        administrator -> ui_catalog "Reads a script's header, then selects it"
        administrator -> ui_console "Starts, watches, answers and stops a run"
        administrator -> ui_results "Views, copies and downloads results"
        administrator -> ui_schedules "Checks recurring jobs, runs one now"
        root -> ui_admin "Maintains areas, directories and entitlements"

        ui_auth -> ui_proxy "POST /api/auth/login" "JSON/HTTPS"
        ui_nav -> ui_proxy "GET /api/areas" "JSON/HTTPS"
        ui_catalog -> ui_proxy "GET /api/areas/{id}/scripts" "JSON/HTTPS"
        ui_console -> ui_proxy "POST, GET and DELETE /api/runs" "JSON/HTTPS"
        ui_results -> ui_proxy "GET /api/runs/{id}/results" "JSON/HTTPS"
        ui_schedules -> ui_proxy "GET /api/areas/{id}/schedules" "JSON/HTTPS"
        ui_admin -> ui_proxy "Area administration" "JSON/HTTPS"
        ui_console -> ui_stream "Mounts the terminal"

        ui_proxy -> backend "Server-side fetch carrying the session cookie" "JSON/HTTPS"
        ui_stream -> api_stream "Terminal bytes out, keystrokes in" "WSS"

        # ── Control plane components ──────────────────────────────────────────────
        ui_proxy -> api_auth "Login and logout" "JSON/HTTPS"
        ui_proxy -> api_areas "Areas of the session" "JSON/HTTPS"
        ui_proxy -> api_catalog "Scripts of an area" "JSON/HTTPS"
        ui_proxy -> api_runs "Start, poll and abort a run" "JSON/HTTPS"
        ui_proxy -> api_results "List and download results" "JSON/HTTPS"
        ui_proxy -> api_schedules "Recurring jobs" "JSON/HTTPS"
        ui_proxy -> api_audit "Audit log, root only" "JSON/HTTPS"

        api_auth -> svc_auth "Delegates" "internal"
        api_areas -> svc_areas "Delegates" "internal"
        api_catalog -> svc_catalog "Delegates" "internal"
        api_runs -> svc_runs "Delegates" "internal"
        api_results -> svc_results "Delegates" "internal"
        api_schedules -> svc_schedules "Delegates" "internal"
        api_audit -> svc_audit "Delegates" "internal"

        svc_auth -> directory "Simple bind with the caller's own credentials" "LDAPS"
        svc_auth -> svc_authz "Hands over for group resolution" "internal"
        svc_auth -> lib_session "Creates the session" "internal"
        svc_auth -> svc_audit "Login succeeded or failed" "internal"
        svc_authz -> directory "Reads the group membership" "LDAPS"
        svc_authz -> lib_repo "Resolves groups to areas" "internal"
        svc_authz -> lib_session "Writes the area set into the session" "internal"

        svc_areas -> lib_repo "Reads and writes" "internal"
        svc_areas -> svc_audit "Records every administrative change" "internal"
        svc_catalog -> run_scanner "Lists the directory, reads the headers" "queue"
        svc_catalog -> lib_repo "Caches the parsed metadata" "internal"
        svc_runs -> svc_authz "Re-checks the session's areas before every start" "internal"
        svc_runs -> lib_repo "Writes the run record" "internal"
        svc_runs -> svc_audit "Run started, run aborted" "internal"
        svc_runs -> run_consumer "Dispatches the run job" "queue"
        svc_runs -> run_abort "Requests the staged abort" "queue"
        svc_results -> run_collector "Lists and streams the output directory" "queue"
        svc_results -> svc_audit "Records every download" "internal"
        svc_results -> lib_repo "Result records" "internal"
        svc_schedules -> run_cron "Reads and writes the crontab" "queue"
        svc_schedules -> lib_repo "Job metadata and last successful run" "internal"
        svc_audit -> lib_repo "Writes the audit trail" "internal"
        svc_audit -> logs "Emits a structured log line" "Syslog"
        lib_repo -> database "Every read and write" "SQL/TCP"
        lib_session -> broker "Session read, write and invalidate" "RESP/TCP"
        api_stream -> lib_session "Authorises the upgrade" "internal"
        api_stream -> broker "Reads the run stream, publishes stdin" "RESP/TCP"
        api_health -> database "Readiness probe" "SQL/TCP"
        api_health -> broker "Readiness probe" "RESP/TCP"
        monitoring -> api_health "Polls liveness and readiness" "HTTPS"

        # ── Runner components ─────────────────────────────────────────────────────
        run_consumer -> broker "Claims a run job" "RESP/TCP"
        run_consumer -> run_driver "Executes the claimed run" "internal"
        run_driver -> run_ssh "Opens the connection to the script VM" "internal"
        run_ssh -> script_vm "Outbound SSH, host key pinned" "SSH"
        run_ssh -> run_pty "Allocates the PTY, starts the script" "internal"
        run_pty -> run_publisher "Raw stdout and stderr bytes" "internal"
        run_pty -> lib_repo "Run state transitions and run events" "internal"
        run_publisher -> broker "Appends to the capped stream" "RESP/TCP"
        run_stdin -> broker "Subscribes to this run's stdin channel" "RESP/TCP"
        run_stdin -> run_pty "Writes the keystrokes into the PTY" "internal"
        run_abort -> run_ssh "Second channel, signals the process group" "internal"
        run_abort -> run_pty "Stops the session once the process is gone" "internal"
        run_collector -> script_vm "Lists and reads the output directory" "SFTP"
        run_collector -> lib_repo "Writes the result records" "internal"
        run_scanner -> script_vm "Lists the script directory, reads the headers" "SFTP"
        run_cron -> script_vm "Reads and writes the crontab" "SSH"

        # ── Deployment, local ─────────────────────────────────────────────────────
        # Not Terraform's business and never will be: this is the docker-compose
        # stack on a workstation, and the two fixtures are what make the
        # interactive path testable without access to a real script VM or a real
        # directory. Named "Local" rather than "Dev" since Dev is now a
        # provisioned environment.
        deploymentEnvironment "Local" {
            deploymentNode "Developer Workstation" "The script VM is a container with sshd and the reference scripts." "Linux / Containers" {
                deploymentNode "frontend" "Dev server on :3000" "Node" {
                    containerInstance frontend
                }
                deploymentNode "backend" "API on :3001, started through its custom server" "Node" {
                    containerInstance backend
                }
                deploymentNode "runner" "No listening port" "Node" {
                    containerInstance runner
                }
                deploymentNode "postgres" "" "Container / PostgreSQL" {
                    containerInstance database
                }
                deploymentNode "redis" "" "Container / Redis" {
                    containerInstance broker
                }
                deploymentNode "sshd fixture" "Stands in for the script VM" "Container / OpenSSH" {
                    softwareSystemInstance script_vm
                }
                deploymentNode "openldap fixture" "Stands in for the directory" "Container / OpenLDAP" {
                    softwareSystemInstance directory
                }
            }
        }

        # ── Deployment, provisioned environments ──────────────────────────────────
        # Staging and Production are the same five instances from the same
        # Terraform modules, differing only in size and process count. That
        # sameness is the point: staging is worth having only while it is shaped
        # like production, and a module that takes a different path per
        # environment stops proving anything.
        #
        # Dev is smaller on purpose — one VM carries the proxy, the frontend, the
        # control plane, both stores and the directory. It buys a place to run the
        # thing, not evidence about how it behaves under load.
        #
        # The runner is its own instance in all three. It is the only component
        # holding SSH keys and the only one that reaches the script VM, so the
        # boundary is drawn where the credentials are. The frontend, by contrast,
        # is a renderer holding no credentials of its own, and separating it from
        # the control plane inside the same VPC, behind the same proxy, would buy
        # a boundary nothing enforces while putting a cross-host hop on every call
        # the API proxy makes.
        #
        # Process counts are processes on one host. They survive a process dying,
        # not the host dying, and the labels say so rather than implying an
        # availability property this shape does not have. Real HA would need a
        # second app instance behind the balancer — a cost decision, not a drawing
        # decision.
        #
        # Dev is modelled but deliberately not drawn: its sizing is in the
        # README's environment table, and a third picture would add a page
        # without adding a fact.
        #
        # Everything sits inside one private VPC per environment, including the
        # script VM and the directory. The reverse proxy is the only thing with a
        # public address — see NFR-01, which this arrangement rewrites rather than
        # abandons.

        deploymentEnvironment "Dev" {
            deploymentNode "Linode" "One region, one VPC." "Linode" {
                deploymentNode "VPC scriptoria-dev" "Private. The proxy holds the only public address; everything else is reachable only from inside it (NFR-01)." "Linode VPC / Firewall" {
                    deploymentNode "scriptoria" "One VM for the platform: proxy, frontend and control plane, with the stores and the directory beside them. Everything that is separate in production, together." "Linode Instance / rootless containers" {
                        deploymentNode "reverse proxy" "TLS termination and the routing split between the frontend and the control plane." "systemd / nginx" {
                        }
                        deploymentNode "frontend" "Standalone build; the target machine never runs an install." "Node" {
                            containerInstance frontend
                        }
                        deploymentNode "backend" "One process. Enough to exercise the code paths, not enough to say anything about availability." "Node · 1 process" {
                            containerInstance backend
                        }
                        deploymentNode "postgres" "" "PostgreSQL" {
                            containerInstance database
                        }
                        deploymentNode "redis" "" "Redis" {
                            containerInstance broker
                        }
                        deploymentNode "openldap" "Seeded with the same account shapes as the local fixture." "OpenLDAP" {
                            softwareSystemInstance directory
                        }
                    }
                    deploymentNode "runner" "Its own VM even here, because it is the only thing holding SSH keys and the only thing that reaches the script VM. Collapsing it into the platform VM would make dev the one environment where that boundary does not exist." "Linode Instance / rootless containers" {
                        deploymentNode "runner" "One process, so O-7's concurrency question stays untested here." "Node · 1 process" {
                            containerInstance runner
                        }
                    }
                    deploymentNode "script" "Provisioned, then left alone. The platform installs nothing here (NFR-07)." "Linode Instance" {
                        softwareSystemInstance script_vm
                    }
                }
            }
        }

        deploymentEnvironment "Staging" {
            deploymentNode "Linode" "Same region and module versions as production." "Linode" {
                deploymentNode "VPC scriptoria-staging" "Private. The proxy holds the only public address; everything else is reachable only from inside it (NFR-01)." "Linode VPC / Firewall" {
                    deploymentNode "app" "" "Linode Instance / rootless containers" {
                        deploymentNode "reverse proxy" "TLS termination and the routing split between the frontend and the control plane. The terminal WebSocket goes straight through to the backend." "systemd / nginx" {
                        }
                        deploymentNode "frontend" "Standalone build; the target machine never runs an install." "Node" {
                            containerInstance frontend
                        }
                        deploymentNode "backend" "Stateless. A process can be replaced mid-run without dropping a PTY, because no process holds one — the runner does." "Node · 2 processes" 2 {
                            containerInstance backend
                        }
                    }
                    deploymentNode "runner" "Its own instance. It is the only thing holding SSH keys and the only thing that reaches the script VM, so the boundary sits where the credentials are rather than around a frontend that holds none." "Linode Instance / rootless containers" {
                        deploymentNode "runner" "Holds the SSH keys and the PTYs. Its own release cycle." "Node · 2 processes" 2 {
                            containerInstance runner
                        }
                    }
                    deploymentNode "data" "" "Linode Instance" {
                        deploymentNode "postgres" "" "PostgreSQL" {
                            containerInstance database
                        }
                        deploymentNode "redis" "" "Redis" {
                            containerInstance broker
                        }
                    }
                    deploymentNode "script" "A real script VM with real scripts on it — the one thing the fixture cannot stand in for (O-6)." "Linode Instance" {
                        softwareSystemInstance script_vm
                    }
                    deploymentNode "ldap" "" "Linode Instance / OpenLDAP" {
                        softwareSystemInstance directory
                    }
                }
            }
            deploymentNode "Monitoring" "" "External" {
                softwareSystemInstance monitoring
            }
            deploymentNode "Log Platform" "" "External" {
                softwareSystemInstance logs
            }
        }

        deploymentEnvironment "Production" {
            deploymentNode "Linode" "" "Linode" {
                deploymentNode "VPC scriptoria-prod" "Private. The proxy holds the only public address; everything else is reachable only from inside it (NFR-01)." "Linode VPC / Firewall" {
                    deploymentNode "app" "" "Linode Instance / rootless containers" {
                        deploymentNode "reverse proxy" "TLS termination and the routing split between the frontend and the control plane. The terminal WebSocket goes straight through to the backend." "systemd / nginx" {
                        }
                        deploymentNode "frontend" "Standalone build; the target machine never runs an install." "Node" {
                            containerInstance frontend
                        }
                        deploymentNode "backend" "Stateless. A process can be replaced mid-run without dropping a PTY, because no process holds one — the runner does." "Node · 3 processes" 3 {
                            containerInstance backend
                        }
                    }
                    deploymentNode "runner" "Its own instance. It is the only thing holding SSH keys and the only thing that reaches the script VM, so the boundary sits where the credentials are rather than around a frontend that holds none." "Linode Instance / rootless containers" {
                        deploymentNode "runner" "Holds the SSH keys and the PTYs. Its own release cycle." "Node · 2 processes" 2 {
                            containerInstance runner
                        }
                    }
                    deploymentNode "data" "Backed up. The audit trail lives here and is the one thing that cannot be rebuilt." "Linode Instance" {
                        deploymentNode "postgres" "" "PostgreSQL" {
                            containerInstance database
                        }
                        deploymentNode "redis" "" "Redis" {
                            containerInstance broker
                        }
                    }
                    deploymentNode "script" "One instance is the normal case; more are possible (NFR-07). Nothing is installed here and no port is opened to the internet." "Linode Instance" {
                        softwareSystemInstance script_vm
                    }
                    deploymentNode "ldap" "Authoritative for every account and group (NFR-03, NFR-04)." "Linode Instance / OpenLDAP" {
                        softwareSystemInstance directory
                    }
                }
            }
            deploymentNode "Monitoring" "" "External" {
                softwareSystemInstance monitoring
            }
            deploymentNode "Log Platform" "" "External" {
                softwareSystemInstance logs
            }
        }

        # ── Deployment, module portability ────────────────────────────────────────
        # Not an environment anybody deploys. It is the contract the per-provider
        # module implementations satisfy, drawn once so the portability claim can
        # be checked rather than asserted.
        #
        # Only the Linode implementation is deployed. The other three exist so the
        # interface stays honest: an interface with one implementation is just the
        # implementation with extra steps, and the first real port is where you
        # find out which assumptions were Linode's rather than the platform's.
        deploymentEnvironment "Portability" {
            deploymentNode "modules/network" "One private network per environment, with the public address as the only way in." "linode VPC+Firewall · aws VPC+SG · azure VNet+NSG · gcp VPC+Firewall" {
                deploymentNode "modules/edge" "The public address and TLS. Holds no application — everything it fronts runs in modules/app." "linode NodeBalancer · aws ALB · azure AppGateway · gcp HTTPS-LB" {
                }
                deploymentNode "modules/app" "The proxy, the frontend and the control plane on one instance. The module whose process counts differ between environments." "linode Instance · aws EC2+ASG · azure VMSS · gcp MIG" {
                    containerInstance frontend
                    containerInstance backend
                }
                deploymentNode "modules/runner" "Its own instance everywhere, because it is the only module that holds SSH keys and the only one that reaches the script VM." "linode Instance · aws EC2+ASG · azure VMSS · gcp MIG" {
                    containerInstance runner
                }
                deploymentNode "modules/data" "Where the portability claim is thinnest: every provider has managed Postgres and Redis, and no two agree on how to configure them." "linode ManagedDB · aws RDS+ElastiCache · azure FlexServer+Cache · gcp CloudSQL+Memorystore" {
                    containerInstance database
                    containerInstance broker
                }
                deploymentNode "modules/script" "The one node no provider abstraction helps with, and the one that needs none. The platform installs nothing here (NFR-07)." "a plain Linux VM, identical on all four" {
                    softwareSystemInstance script_vm
                }
                deploymentNode "modules/directory" "Deliberately not a managed identity service: NFR-02 rules out an external identity provider, which removes the one place each cloud would differ most." "a plain VM running OpenLDAP, all four" {
                    softwareSystemInstance directory
                }
            }
        }
    }

    views {
        # `autoLayout` takes a direction and then rank and node separation in
        # pixels. The defaults (300, 300) pack these graphs tightly enough that
        # the edge labels overlap the boxes, so both are raised.
        #
        # These figures lay out Structurizr Lite at :8088. They do NOT reach the
        # exported PNGs and PDF: the PlantUML exporter divides them by 5 and 10
        # respectively, which is far too tight for a picture nobody can pan, so
        # scripts/diagrams.ts overrides the separation on the way out. Tune these
        # for Lite; tune the constants in that script for the rendered files.

        systemcontext scriptoria "SystemContext" {
            include *
            autoLayout tb 400 400
            description "Scriptoria talks to one thing: the script VM. There is no edge to the target systems — the scripts reach those themselves, with their own credentials (NFR-06)."
        }

        container scriptoria "Container" {
            include *
            autoLayout tb 400 400
            description "The runner is separate from the backend because a run is a stateful, minutes-long PTY session. See ADR-001 and ADR-007."
        }

        component frontend "Component_Frontend" {
            include *
            autoLayout lr 400 300
            description "Every REST call leaves through the API proxy. The terminal WebSocket is the one exception and is authorised on upgrade (ADR-007)."
        }

        # The control plane is split across three component views on purpose. One
        # view of all 21 components carried 47 relationships, and every edge
        # crossed every other: technically complete, unreadable in practice.
        # Each view below answers one question, and a component that serves two
        # of them appears in both.

        component backend "Component_Backend_Requests" {
            include frontend api_auth api_areas api_catalog api_runs api_results api_schedules api_docs
            include svc_auth svc_areas svc_catalog svc_runs svc_results svc_schedules lib_result
            autoLayout lr 400 300
            description "The delegation spine. Every route is a thin shell: validate, call exactly one service, map the Result<T> to a response. No route reaches the database, and no route holds domain logic."
        }

        component backend "Component_Backend_Auth" {
            include frontend api_auth api_stream svc_auth svc_authz svc_audit lib_session directory broker
            autoLayout lr 400 300
            description "Who the caller is, and what they may see. The bind is made with the caller's own credentials, entitlements are rebuilt from the directory at every login (NFR-03), and the session itself is opaque and server-side. The terminal upgrade is authorised the same way — ADR-007."
        }

        component backend "Component_Backend_Data" {
            include svc_areas svc_authz svc_catalog svc_runs svc_results svc_schedules svc_audit api_audit api_health
            include frontend lib_repo lib_session database broker logs monitoring
            autoLayout lr 400 300
            description "Everything that outlives a request. Only the repository layer speaks SQL, every service records through the audit service, and an audit write can never fail the operation it records."
        }

        component runner "Component_Runner" {
            include *
            autoLayout lr 400 300
            description "Everything above the execution driver is written against the ExecutionTarget interface, so replacing SSH stays a local change (ADR-001)."
        }

        deployment scriptoria "Local" "Deployment_Local" {
            include *
            autoLayout tb 400 400
            description "The sshd and OpenLDAP fixtures stand in for the script VM and the directory, so the whole interactive path is testable locally. Nothing here is provisioned by Terraform."
        }

        deployment scriptoria "Staging" "Deployment_Staging" {
            include *
            autoLayout tb 400 400
            description "Production's shape at a smaller size, from the same modules at the same versions. Two backend replicas and two runners, because one of each cannot exercise replacing a replica mid-run or routing stdin to the worker that holds the PTY."
        }

        deployment scriptoria "Production" "Deployment_Production" {
            include *
            autoLayout tb 400 400
            description "Every connection to the script VM is outbound and stays inside the VPC. Nothing is installed there and no port is opened to the internet, so its hardening stands unchanged."
        }

        deployment scriptoria "Portability" "Deployment_Portability" {
            include *
            autoLayout tb 400 400
            description "The contract each provider implementation satisfies, not an environment anybody deploys. Only the Linode implementation runs; the other three keep the interface honest, since an interface with one implementation is the implementation with extra steps."
        }

        styles {
            element "Person" {
                color #ffffff
                background #08427b
                fontSize 22
                shape Person
            }
            element "Software System" {
                background #1168bd
                color #ffffff
                width 500
                height 320
            }
            element "Existing System" {
                background #999999
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
                width 500
                height 320
            }
            element "Database" {
                shape Cylinder
            }
            element "Component" {
                background #85bbf0
                color #000000
                width 480
                height 300
            }
            relationship "Relationship" {
                fontSize 22
                width 450
            }
        }
    }
}
