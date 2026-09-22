#!/usr/bin/env bash
# Increment t4: courses can be renamed (the answer to the client's note); CourseDetails copy 4 (staged as draft).
# Run from your project root on branch increment/t4:  bash ~/Projects/Eventmodelers-Build-Kits/docs/examples/t4.sh
set -euo pipefail
source em-helpers.sh

REG_EVT=$(el_id 'register course' event courseWasRegistered)
CAP_EVT=$(el_id 'change course capacity' event courseCapacityWasChanged)
RS_EVT=$(el_id 'register student' event studentWasRegistered)
SUB_EVT=$(el_id 'subscribe student' event studentWasSubscribed)
UNSUB_EVT=$(el_id 'unsubscribe student' event studentWasUnsubscribed)

emcli slice add "$(chapter_id)" "change course title" >/dev/null
emcli element add "$(chapter_id)" "$(slice_id 'change course title')" "$(lane_id Enrollment)" command changeCourseTitle >/dev/null
emcli element add "$(chapter_id)" "$(slice_id 'change course title')" "$(lane_id 'Enrollment Events')" event courseTitleWasChanged >/dev/null
TITLE_CMD=$(el_id 'change course title' command changeCourseTitle); TITLE_EVT=$(el_id 'change course title' event courseTitleWasChanged)
for el in "$TITLE_CMD" "$TITLE_EVT"; do
  emcli element field add "$(chapter_id)" "$el" courseId String --id --example c1 >/dev/null
  emcli element field add "$(chapter_id)" "$el" newTitle String --example "Advanced Math" >/dev/null
done
emcli dependency add "$TITLE_CMD" "$TITLE_EVT" produces >/dev/null
emcli element update "$(chapter_id)" "$TITLE_CMD" --api-endpoint "/courses/{courseId}/title" >/dev/null

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'change course title')" "renames a registered course" --json | jq -r .id)
step "change course title" "$sp" given event "$REG_EVT"; step "change course title" "$sp" when command "$TITLE_CMD"
step "change course title" "$sp" then event "$TITLE_EVT"
ex "change course title" "$sp" given 0 courseId c1; ex "change course title" "$sp" given 0 title Math; ex "change course title" "$sp" given 0 capacity 30
for ph in when then; do ex "change course title" "$sp" $ph 0 courseId c1; ex "change course title" "$sp" $ph 0 newTitle "Advanced Math"; done
sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'change course title')" "rejects renaming an unknown course" --json | jq -r .id)
step "change course title" "$sp" when command "$TITLE_CMD"
error_step "change course title" "$sp" "Course not found"
ex "change course title" "$sp" when 0 courseId c9; ex "change course title" "$sp" when 0 newTitle "Advanced Math"

emcli slice add "$(chapter_id)" "course details title" >/dev/null
emcli element copy "$(chapter_id)" "$(el_id 'course details' information CourseDetails)" \
  --slice "$(slice_id 'course details title')" --lane "$(lane_id Enrollment)" >/dev/null
DETAILS_4=$(el_id 'course details title' information CourseDetails)
emcli element field add "$(chapter_id)" "$DETAILS_4" subscribedStudents Custom --cardinality List --subfields "studentId:String,name:String" >/dev/null
for e in "$REG_EVT" "$CAP_EVT" "$RS_EVT" "$SUB_EVT" "$UNSUB_EVT" "$TITLE_EVT"; do emcli dependency add "$e" "$DETAILS_4" hydrates >/dev/null; done

sp=$(emcli spec add "$(chapter_id)" "$(slice_id 'course details title')" "shows the new title" --json | jq -r .id)
step "course details title" "$sp" given event "$REG_EVT"
step "course details title" "$sp" given event "$TITLE_EVT"
step "course details title" "$sp" then readmodel "$DETAILS_4"
ex "course details title" "$sp" given 0 courseId c1; ex "course details title" "$sp" given 0 title Math; ex "course details title" "$sp" given 0 capacity 30
ex "course details title" "$sp" given 1 courseId c1; ex "course details title" "$sp" given 1 newTitle "Advanced Math"
ex "course details title" "$sp" then 0 courseId c1; ex "course details title" "$sp" then 0 title "Advanced Math"

emcli slice status "$(chapter_id)" "$(slice_id 'change course title')" planned >/dev/null
emcli slice status "$(chapter_id)" "$(slice_id 'course details title')" draft >/dev/null
echo "t4 modeled: 'change course title' planned, 'course details title' draft"
