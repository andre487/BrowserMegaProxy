"""Render the pinned server's real templates and client exports, without provisioning."""
import json
import sys
import runpy
import yaml
from pathlib import Path

from jinja2 import Environment, StrictUndefined
from megaproxy_server.generate import generate
from megaproxy_server.inventory import https_routes, save
from megaproxy_server.models import Inventory

source, output, scenario, published_port = sys.argv[1:]
source, output = Path(source), Path(output)
ip_endpoint = scenario == "ip"
chain_only = scenario == "chain-only"
masked = scenario in ("knock", "masked", "override")
knock = ["knock.invalid"] if scenario in ("knock", "override") else []
probe = {"enabled": masked, "mode": "local_decoy" if masked else "disabled", "knock": knock}
admin = {"user": "deploy", "private_key_file": "/unused", "public_key": "ssh-ed25519 AAAA test"}
https = {"endpoint": "127.0.0.1" if ip_endpoint else "direct.localhost", "port": int(published_port), "certificate": "ip-acme" if ip_endpoint else "domain", "acme_email": "test@example.invalid", "chain_entry": not ip_endpoint, "direct": not chain_only, "probe_resistance": probe}
inventory = Inventory.model_validate({
    "settings": {"https_chains_enabled": not ip_endpoint, "https_chain_domain": "localhost", "https_chain_backend_port": 10443,
                 "https_chain_pairs": [] if ip_endpoint else [{"entry": "de_entry", "exit": "us_exit", "hostname": "chain.localhost", "country_code": "US", "title": "DE → US", **({"probe_resistance": {"enabled": False, "mode": "disabled"}} if scenario == "override" else {})}]},
    "users": {"https": [{"name": "user", "password": "secret-password:with@symbols"}],
              "ssh": [{"name": "sshuser", "authentication": {"type": "password", "password": "ssh-secret-password", "password_hash": "unused"}}]},
    "hosts": {
        "de_entry": {"address": "direct.localhost", "admin": admin, "services": {"https": https, "ssh": {"port": 22}}},
        "us_exit": {"address": "exit.internal", "admin": admin, "services": {"https": {"endpoint": "exit.internal", "certificate": "domain", "acme_email": "test@example.invalid", "port": 10443, "chain_exit": True, "chain_password": "machine-password-not-for-clients"}, "ssh": {"port": 22}}},
    },
})
save(output / "inventory.yml", inventory)
generate(output / "inventory.yml", output / "exports")
env = Environment(undefined=StrictUndefined, keep_trailing_newline=True)
env.filters["to_json"] = json.dumps
for host_name, filename in [("de_entry", "entry"), ("us_exit", "exit")]:
    service = inventory.hosts[host_name].services.https
    routes = https_routes(inventory, host_name)
    # Test-only Docker transport addresses; handler/auth/probe/chain logic is unchanged.
    services = {"https": {"routes": routes, "users": [user.model_dump() for user in service.users],
                          "machine_auth": {"username": service.chain_username, "password": service.chain_password} if service.chain_exit else None,
                          "port": 18443}}
    text = env.from_string((source / "roles/https_proxy/templates/gost.yml.j2").read_text()).render(
        megaproxy_services=services, megaproxy_container_certificate_directory="/fixture")
    config = yaml.safe_load(text)
    for route in config["services"]:
        if route["name"] != "decoy":
            route["addr"] = route["addr"].replace("127.0.0.1:", "0.0.0.0:")
        else:
            route["handler"]["metadata"]["dir"] = "/fixture/decoy"
    (output / f"{filename}.json").write_text(json.dumps(config))
    if filename == "entry":
        text = env.from_string((source / "roles/https_proxy/templates/haproxy.cfg.j2").read_text()).render(megaproxy_services=services)
        (output / "haproxy.cfg").write_text(text)
# Use the project's real decoy generator too.
runpy.run_path(str(source / "roles/https_proxy/files/generate-decoy.py"))["generate"](output / "decoy")

# Generate the actual self-signed export too. Browsers must reject its unsafe flag.
unsafe = inventory.model_copy(deep=True)
unsafe.settings.https_chains_enabled = False
unsafe.settings.https_chain_pairs = []
for host in unsafe.hosts.values():
    host.services.https.chain_entry = False
    host.services.https.chain_exit = False
    host.services.https.direct = True
    host.services.https.certificate = "self-signed"
save(output / "self-signed.yml", unsafe)
generate(output / "self-signed.yml", output / "self-signed-exports")
