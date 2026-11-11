"""A Bunkr tuning file must never enter another provider's app target."""
import json,os,pathlib,re,subprocess,sys,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class ProviderIsolation(unittest.TestCase):
 def test_build_targets_select_only_their_own_player_implementation(self):
  env={k:v for k,v in os.environ.items() if k not in {'SIMULATOR','DECODER_PROBE','INLINE_CODEC_QUICK','INLINE_CODEC_PERFORMANCE'}}
  registry=json.loads((ROOT/'providers.json').read_text())
  for key,config in registry.items():
   with self.subTest(provider=key):
    subprocess.run([sys.executable,str(ROOT/'scripts/project.py'),key],env=env,check=True,capture_output=True)
    # Bunkr's own generator writes its project per provider; every other provider shares one.
    path=(ROOT/'build'/key/(config['product']+'.xcodeproj') if key=='bunkr' else ROOT/'build'/'app'/'VideoApp.xcodeproj')
    project=(path/'project.pbxproj').read_text()
    sources=re.findall(r'"path" = "([^"\n]+\.swift)"',project)
    special=[p for p in sources if '/ios/Bunkr/' in p]
    if key=='bunkr':
     self.assertTrue(any(p.endswith('/Bunkr/ViewerUnit.swift') for p in special))
     self.assertTrue(any(p.endswith('/Bunkr/FFmpegVideoDecoder.swift') for p in special))
     self.assertIn('AetherEngine',project)
    else:
     self.assertEqual(special,[])
     self.assertNotIn('AetherEngine',project)
     self.assertNotIn('VLCKit',project)
     self.assertTrue(any(p.endswith('/VideoApp/ViewerUnit.swift') for p in sources))
 def test_dedicated_bunkr_generator_rejects_other_providers(self):
  result=subprocess.run([sys.executable,str(ROOT/'Bunkr/project.py'),'sc'],capture_output=True,text=True)
  self.assertNotEqual(result.returncode,0)
 def test_only_bunkr_renewal_inputs_include_performance_overrides(self):
  result=subprocess.check_output([sys.executable,str(ROOT/'scripts/renewal.py'),'--team','TEST','--device','TEST'],text=True)
  for app in json.loads(result)['apps']:
   self.assertEqual('Bunkr' in app['inputs'],app['name']=='bunkr-local')
