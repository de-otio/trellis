.PHONY: init plan apply outputs test destroy clean

# Requires SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID,
# SCW_DEFAULT_ORGANIZATION_ID to be exported before any of these run
# (except `clean`). See README.md.

init:
	cd infra && tofu init

plan:
	cd infra && tofu plan

apply:
	cd infra && tofu apply

outputs:
	cd infra && tofu output -json > outputs.json

test:
	cd harness && npm install && G1_OUTPUTS_JSON=../infra/outputs.json npx tsx run-all.ts

destroy:
	cd infra && tofu destroy

clean:
	rm -rf infra/.terraform infra/.terraform.lock.hcl infra/*.tfstate infra/*.tfstate.* infra/outputs.json harness/node_modules
