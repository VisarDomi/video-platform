"""Fresh service-state proof is required even with a prior completed pause."""
import contextlib,io,json,os
from pathlib import Path
import subprocess,sys,tempfile,unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
import pipeline_control as u


class PauseReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.home=Path(self.temp.name)
        self.marker=self.home/'.local/share/video-services/pipeline/user-pause.json'
        self.override=self.home/'.config/systemd/user/video-pipeline.service.d/90-user-requested-pause.conf'
        self.receipt=self.home/'.local/share/video-services/pipeline/pause-completed.json';self.calls=[]
        self.values={'LoadState':'loaded','ActiveState':'inactive','SubState':'dead','UnitFileState':'disabled',
                     'NeedDaemonReload':'no','Restart':'no','ControlGroup':'','DropInPaths':str(self.override)}
        self.conditions={'type':'a(sbbsi)','data':[['ConditionPathExists',False,True,str(self.marker),0]]}
        self.after_conditions=None;self.query_error=None;self.node_error=None
    def runner(self,args,**kwargs):
        self.calls.append(list(args));stdout=''
        if args[0]=='systemctl' and 'show' in args:
            stdout='\n'.join(k+'='+v for k,v in self.values.items())+'\n'
        elif args[0]=='busctl':
            if self.query_error:raise self.query_error
            stdout=json.dumps(self.conditions)
            if self.after_conditions:self.after_conditions()
        elif 'campaign-pause' in args and self.node_error:raise self.node_error
        return subprocess.CompletedProcess(args,0,stdout=stdout)
    def pause(self):
        with patch.object(u.Path,'home',return_value=self.home),patch.object(u.subprocess,'run',side_effect=self.runner),contextlib.redirect_stdout(io.StringIO()):
            u.pause_upload_pipeline()
    def seed(self):
        self.pause();self.assertTrue(self.receipt.exists());self.calls=[]
    def full_called(self):return any('campaign-pause' in c for c in self.calls)
    def test_completed_pause_reuses_only_after_two_fresh_queries(self):
        self.seed();initial=json.loads(self.marker.read_text());override=self.override.stat().st_mtime_ns
        for _ in range(2):
            self.calls=[];self.pause()
            self.assertEqual(len(self.calls),2);self.assertEqual(self.calls[0][:4],['systemctl','--user','show',u.UNIT])
            self.assertEqual(self.calls[1][0],'busctl');self.assertFalse(self.full_called())
        self.assertEqual(self.override.stat().st_mtime_ns,override)
        self.assertEqual(json.loads(self.marker.read_text())['paused_at'],initial['paused_at'])
        self.assertTrue(u._prior_pause(self.receipt,u._regular_bytes(self.marker),u._regular_bytes(self.override)))
    def test_missing_receipt_uses_existing_full_procedure(self):
        self.seed();self.receipt.unlink();self.pause();self.assertTrue(self.full_called())
        self.assertEqual(self.calls[0],['systemctl','--user','daemon-reload'])
    def test_changed_marker_is_not_adopted_as_completed_pause(self):
        self.seed();value=json.loads(self.marker.read_text());value['external_change']='kept';self.marker.write_text(json.dumps(value))
        self.pause();self.assertTrue(self.full_called());self.assertEqual(json.loads(self.marker.read_text())['external_change'],'kept')
    def test_changed_owned_override_forces_reload_and_stop(self):
        self.seed();self.override.write_text(self.override.read_text()+'\n# externally changed\n')
        self.pause();self.assertTrue(self.full_called());self.assertEqual(self.calls[0],['systemctl','--user','daemon-reload'])
    def test_unknown_override_is_not_overwritten(self):
        self.seed();self.override.write_text('# different owner\n');before=self.marker.read_bytes()
        with self.assertRaises(RuntimeError):self.pause()
        self.assertEqual(self.marker.read_bytes(),before);self.assertEqual(self.calls,[])
    def test_active_enabled_reload_restart_or_group_uncertainty_forces_full_path(self):
        cases={'LoadState':'error','ActiveState':'active','SubState':'running','UnitFileState':'enabled',
               'NeedDaemonReload':'yes','Restart':'always','ControlGroup':'/unknown','DropInPaths':'/different.conf'}
        for key,value in cases.items():
            self.seed();old=self.values[key];self.values[key]=value
            self.pause();self.assertTrue(self.full_called(),key);self.values[key]=old
    def test_negated_nontrigger_exact_path_condition_is_required(self):
        cases=[{}, {'type':'other','data':[]}, {'type':'a(sbbsi)','data':[]},
               {'type':'a(sbbsi)','data':[['ConditionPathExists',True,True,str(self.marker),0]]},
               {'type':'a(sbbsi)','data':[['ConditionPathExists',False,False,str(self.marker),0]]},
               {'type':'a(sbbsi)','data':[['ConditionPathExists',False,True,'/different',0]]},
               {'type':'a(sbbsi)','data':[['ConditionPathExists',0,True,str(self.marker),0]]},
               {'type':'a(sbbsi)','data':[['ConditionPathExists',False,True,str(self.marker),True]]}]
        original=self.conditions
        for condition in cases:
            self.conditions=original;self.seed();self.conditions=condition
            self.pause();self.assertTrue(self.full_called(),condition)
        self.conditions=original
    def test_condition_previous_result_is_not_used_as_current_truth(self):
        for status in (-1,0,1,2):
            self.conditions['data'][0][4]=status;self.seed();self.pause();self.assertFalse(self.full_called())
    def test_failed_condition_query_falls_back_without_false_positive(self):
        self.seed();self.query_error=subprocess.TimeoutExpired(['busctl'],2)
        self.pause();self.assertTrue(self.full_called())
    def test_metadata_change_during_query_cannot_publish_new_completion(self):
        self.seed();before=self.receipt.read_bytes();self.after_conditions=lambda:self.marker.write_text('{}\n')
        with self.assertRaises(RuntimeError):self.pause()
        self.assertEqual(self.receipt.read_bytes(),before)
    def test_failed_full_pause_does_not_create_completion_receipt(self):
        self.node_error=subprocess.CalledProcessError(1,['campaign-pause'])
        with self.assertRaises(subprocess.CalledProcessError):self.pause()
        self.assertFalse(self.receipt.exists())
    def test_symlink_receipt_is_never_read_as_proof_or_written_through(self):
        self.seed();self.receipt.unlink();target=self.home/'foreign';target.write_text('foreign data')
        self.receipt.symlink_to(target);self.pause();self.assertTrue(self.full_called())
        self.assertEqual(target.read_text(),'foreign data');self.assertFalse(self.receipt.is_symlink())
    def test_boolean_version_is_not_a_valid_receipt(self):
        self.seed();value=json.loads(self.receipt.read_text());value['v']=True;self.receipt.write_text(json.dumps(value))
        self.pause();self.assertTrue(self.full_called())
    def test_receipt_publication_failure_prevents_success(self):
        original=u.private_write;first=OSError('receipt failed')
        def write(path,text):
            if path==self.receipt:raise first
            return original(path,text)
        with patch.object(u,'private_write',side_effect=write),self.assertRaises(OSError) as caught:self.pause()
        self.assertIs(caught.exception,first);self.assertFalse(self.receipt.exists())


if __name__=='__main__':unittest.main()
